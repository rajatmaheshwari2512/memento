// An image-edit provider: the photo, an instruction and optionally a marked copy in, an edited
// image out, with its price. Today Gemini only (clients/gemini.client.ts). Which provider makes
// an edit is chosen in one place, per tool (services/edit-providers.service.ts), so another one
// (a pay-per-image API, a model of our own) can be added there without changing the apps, the
// paste-back (done by the apps) or the save.

import type { ImageMime } from "./image.types.ts";

export type ImageSize = "1K" | "2K" | "4K";

// An image on disk: images are never held whole in memory while an edit is made, so many edits
// fit at once (constants/edits.constants.ts, EDITS_AT_ONCE).
export type ImageFile = { path: string; mime: string; bytes: number };

// What every provider gets: the photo, the instruction, the result's size class, for an edit of
// a highlighted area the same photo with that area tinted red (the "mark"), and the edit's own
// folder to put its result in (removed when the edit ends).
export type EditInput = {
  image: ImageFile;
  prompt: string;
  size: ImageSize;
  mark?: ImageFile;
  folder: string;
};

// What it gives back: the edited image (a JPEG, PNG or WebP, checked by its bytes) in a file in
// the edit's folder, the model that made it, and its estimated price (for the log and the monthly
// estimate).
export type EditOutput = { image: ImageFile & { mime: ImageMime }; model: string; costUsd: number };

// Refusals and failures are thrown as HttpErrors with a message the user can read.
export type EditProvider = {
  name: string;
  model: string; // recorded with each edit when its slot under the limits is reserved
  edit: (input: EditInput) => Promise<EditOutput>;
};
