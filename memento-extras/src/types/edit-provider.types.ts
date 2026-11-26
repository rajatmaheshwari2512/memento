// An image edit: the photo, an instruction and optionally a marked copy in, an edited image out, with its price (clients/gemini.client.ts).

import type { ImageMime } from "./image.types.ts";

export type ImageSize = "1K" | "2K" | "4K";

// An image on disk.
export type ImageFile = { path: string; mime: string; bytes: number };

// What an edit gets: the photo, the instruction, the result's size class, for an edit of a highlighted area the marked copy, and the edit's own folder for its result.
export type EditInput = {
  image: ImageFile;
  prompt: string;
  size: ImageSize;
  mark?: ImageFile;
  folder: string;
};

// What it gives back: the edited image in a file in the edit's folder, the model that made it, and its estimated price.
export type EditOutput = { image: ImageFile & { mime: ImageMime }; model: string; costUsd: number };
