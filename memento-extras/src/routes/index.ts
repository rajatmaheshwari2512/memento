// Every route the service answers, and finding the one for a request. Caddy forwards photos.<domain>/extras/* here with the /extras prefix removed.
// POST, PUT and DELETE must have Content-Type: application/json, or image/jpeg or image/png for the saves of photos the apps send.

import type { IncomingMessage, ServerResponse } from "node:http";
import { adjustRoutes } from "./adjust.routes.ts";
import { adminRoutes } from "./admin.routes.ts";
import { askRoutes } from "./ask.routes.ts";
import { backupRoutes } from "./backup.routes.ts";
import { editsRoutes } from "./edits.routes.ts";
import { flagsRoutes } from "./flags.routes.ts";
import { healthRoutes } from "./health.routes.ts";
import { liveAlbumsRoutes } from "./live-albums.routes.ts";
import { memoriesRoutes } from "./memories.routes.ts";
import { videosRoutes } from "./videos.routes.ts";
import type { Route } from "../types/http.types.ts";
import { HttpError } from "../utils/http-error.ts";

const routes: Route[] = [...healthRoutes, ...flagsRoutes, ...adminRoutes, ...liveAlbumsRoutes, ...memoriesRoutes, ...backupRoutes, ...askRoutes, ...editsRoutes, ...adjustRoutes, ...videosRoutes];

const matchers = routes.map((route) => {
  const names: string[] = [];
  const pattern = route.path.replace(/:(\w+)/g, (_, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { route, names, regex: new RegExp(`^${pattern}$`) };
});

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://local").pathname;
  for (const { route, names, regex } of matchers) {
    if (route.method !== req.method) continue;
    const match = regex.exec(path);
    if (match) return route.handler(req, res, Object.fromEntries(names.map((name, i) => [name, match[i + 1]!])));
  }
  throw new HttpError(404, "Not found.");
}
