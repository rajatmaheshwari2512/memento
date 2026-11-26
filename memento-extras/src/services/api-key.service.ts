// People's own Immich keys for work done in the background (live albums, themed memories): made from their login, stored encrypted (crypto-box.ts), and replaced when Immich no longer accepts them.

import { createApiKey, deleteApiKey } from "../clients/immich.client.ts";
import type { Credential, User } from "../types/immich.types.ts";
import { open, seal } from "../utils/crypto-box.ts";
import { log } from "../utils/http.ts";

export type StoredKey = { keyId: string; sealed: string };

// What a feature's key is: what it's for (the encryption's purpose, the name in Immich, words
// for messages), its permissions, and a cheap call that only works while Immich accepts it.
export type KeySpec = { purpose: string; name: string; permissions: string[]; what: string; check: (key: Credential) => Promise<unknown> };

// The stored key, ready to use. Throws if it was tampered with, moved to another person, or
// the secret changed.
export function openKey(spec: KeySpec, userId: string, sealed: string): Credential {
  return { name: "x-api-key", value: open(spec.purpose, userId, sealed) };
}

// Keeps the stored key if it's `current` and Immich still accepts it; else replaces it. Returns the new key to store, or null when the old one stays.
export async function renewKey(user: User, cred: Credential, spec: KeySpec, stored: StoredKey | undefined, current: boolean): Promise<StoredKey | null> {
  if (stored && current) {
    try {
      await spec.check(openKey(spec, user.id, stored.sealed));
      return null;
    } catch {
    }
  }
  if (stored) await deleteApiKey(cred, stored.keyId, spec.what).catch(() => {});
  const created = await createApiKey(cred, spec.name, spec.permissions, spec.what);
  log({ event: "api_key_created", for: spec.what, user: user.id, keyId: created.id });
  return { keyId: created.id, sealed: seal(spec.purpose, user.id, created.secret) };
}
