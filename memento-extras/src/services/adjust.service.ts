// Adjust: light and colour sliders, filters and straighten. The apps render the adjusted photo themselves, at full size, and send it here; it's saved as a copy with the original's date and place, stacked on top of it (copies.service.ts).

import { openAsBlob } from "node:fs";
import { getAsset } from "../clients/immich.client.ts";
import { ADJUST_OFF } from "../constants/adjust.constants.ts";
import { getFlags } from "./flags.service.ts";
import { placeWithOriginal, requireOwnPhoto, uploadCopy } from "./copies.service.ts";
import type { Asset, Credential, User } from "../types/immich.types.ts";
import type { ImageMime } from "../types/image.types.ts";
import { HttpError, isUuid } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";

export function requireAdjust(): void {
  if (!getFlags().adjust.enabled) throw new HttpError(403, ADJUST_OFF);
}

// The photo being adjusted: the caller's own, a photo, not in the trash or the locked folder.
export async function adjustableOriginal(user: User, cred: Credential, assetId: string): Promise<Asset> {
  if (!isUuid(assetId)) throw new HttpError(404, "Photo not found.");
  const original = await getAsset(cred, assetId);
  requireOwnPhoto(original, user);
  return original;
}

// Saves the adjusted photo in `path` next to the original. Returns the new photo's ID.
export async function saveAdjusted(user: User, cred: Credential, original: Asset, path: string, mime: ImageMime): Promise<string> {
  const id = await uploadCopy(cred, original, await openAsBlob(path, { type: mime }), mime, "edited");
  await placeWithOriginal(cred, id, original);
  log({ event: "adjust_saved", user: user.id, asset: original.id, newAsset: id });
  return id;
}
