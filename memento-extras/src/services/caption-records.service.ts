// Captions already written: removing the captions of photos gone from Immich for good.

import { captionedAssetIds, captionFailures, deleteCaptions } from "./repositories/captions.repository.ts";
import type { GoneCaptions } from "../types/captions.types.ts";

// Captions of photos gone from Immich for good (not in `existing`, a list of every photo Immich still has) are removed. Removes nothing when there would be more than `max`.
export function removeGoneCaptions(existing: Set<string>, max: number): GoneCaptions {
  const gone = [...captionedAssetIds(), ...captionFailures().keys()].filter((id) => !existing.has(id));
  if (gone.length === 0 || gone.length > max) return { gone: gone.length, removed: false };
  deleteCaptions(gone);
  return { gone: gone.length, removed: true };
}
