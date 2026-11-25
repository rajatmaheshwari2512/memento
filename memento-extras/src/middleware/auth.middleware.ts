// Who is calling? The service has no logins of its own: it takes the user's Immich
// login from the request and asks Immich whose it is.
//   web app:      the immich_access_token cookie (the browser sends it, same domain)
//   Android app:  the x-immich-user-token header
//   testing:      an Immich API key in x-api-key, or Authorization: Bearer
// Share-link keys are deliberately NOT accepted: a public share link must never be
// enough to spend money on edits.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { whoAmI } from "../clients/immich.client.ts";
import { LOGIN_CACHE_MS, LOGIN_TOKEN } from "../constants/http.constants.ts";
import type { Auth, Credential, User } from "../types/immich.types.ts";
import { HttpError } from "../utils/http-error.ts";

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function credentialFrom(req: IncomingMessage): Credential | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  const candidates: Array<[string, string | null | undefined, (v: string) => string]> = [
    ["authorization", bearer?.[1], (v) => `Bearer ${v}`],
    ["x-immich-user-token", req.headers["x-immich-user-token"] as string | undefined, (v) => v],
    ["x-immich-session-token", req.headers["x-immich-session-token"] as string | undefined, (v) => v],
    ["x-api-key", req.headers["x-api-key"] as string | undefined, (v) => v],
    ["cookie", cookieValue(req.headers.cookie, "immich_access_token"), (v) => `immich_access_token=${v}`],
  ];
  for (const [name, raw, format] of candidates) {
    if (raw && LOGIN_TOKEN.test(raw)) return { name, value: format(raw) };
  }
  return null;
}

// Remembers "this login belongs to user X" for a minute, so Immich isn't asked on
// every request. Keyed by a hash, so tokens themselves aren't kept around.
const cache = new Map<string, { user: User; expires: number }>();

export async function requireUser(req: IncomingMessage): Promise<Auth> {
  const cred = credentialFrom(req);
  if (!cred) throw new HttpError(401, "Not logged in to Immich.");
  const key = createHash("sha256").update(`${cred.name}\n${cred.value}`).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { user: hit.user, cred };
  const user = await whoAmI(cred);
  if (!user) throw new HttpError(401, "Not logged in to Immich.");
  if (cache.size > 1000) cache.clear();
  cache.set(key, { user, expires: Date.now() + LOGIN_CACHE_MS });
  return { user, cred };
}

// From a logged-in browser or app, not an API key: a leaked key can't change anything.
export async function requireSessionUser(req: IncomingMessage): Promise<Auth> {
  const auth = await requireUser(req);
  if (auth.cred.name === "x-api-key") throw new HttpError(403, "Use the app or the web for this, not an API key.");
  return auth;
}

// An Immich admin, logged in: Memento's switches and Memento admin.
export async function requireAdmin(req: IncomingMessage): Promise<Auth> {
  const auth = await requireSessionUser(req);
  if (!auth.user.isAdmin) throw new HttpError(403, "Only an Immich admin can do this.");
  return auth;
}
