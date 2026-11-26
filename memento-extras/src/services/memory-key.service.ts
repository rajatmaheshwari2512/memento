// Each person's own Immich key for themed memories and creations (KEY_PERMISSIONS), made from their login when they turn themed memories on.

import { KeyRejected, timelineMonths } from "../clients/immich.client.ts";
import { KEY_BROKEN, KEY_NAME, KEY_OUTDATED, KEY_PERMISSIONS, KEY_PURPOSE } from "../constants/memories.constants.ts";
import { type KeySpec, openKey, renewKey } from "./api-key.service.ts";
import { memoryUser, saveMemoryKey } from "./repositories/memories.repository.ts";
import type { Credential, User } from "../types/immich.types.ts";

const PERMISSIONS = JSON.stringify(KEY_PERMISSIONS);

const KEY: KeySpec = {
  purpose: KEY_PURPOSE, name: KEY_NAME, permissions: KEY_PERMISSIONS, what: "themed memories",
  check: (key) => timelineMonths(key),
};

// The person's key as a credential, or why there's none: "off" (they turned memories off),
// or a reason to show them (outdated, or it can't be opened).
export function readKey(userId: string): { cred: Credential } | { reason: string } {
  const row = memoryUser(userId);
  if (!row?.sealed) return { reason: "off" };
  if (row.permissions !== PERMISSIONS) return { reason: KEY_OUTDATED };
  try {
    return { cred: openKey(KEY, userId, row.sealed) };
  } catch {
    return { reason: KEY_BROKEN };
  }
}

// Whether an error means Immich no longer accepts the key (deleted, or missing a permission).
export function keyProblem(error: unknown): boolean {
  return error instanceof KeyRejected;
}

// Makes sure the person has a working key with today's permissions, using their login. Saving
// it (new or kept) clears a pause.
export async function ensureKey(user: User, cred: Credential): Promise<void> {
  const row = memoryUser(user.id);
  const stored = row?.sealed && row.key_id ? { keyId: row.key_id, sealed: row.sealed } : undefined;
  const key = (await renewKey(user, cred, KEY, stored, row?.permissions === PERMISSIONS)) ?? stored!;
  saveMemoryKey(user.id, { ...key, permissions: PERMISSIONS });
}
