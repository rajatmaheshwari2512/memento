// AI edits: the request, new results, and results waiting to be saved
// (services/edits.service.ts, repositories/edits.repository.ts).

import type { FileHandle } from "node:fs/promises";
import type { ImageFile, ImageSize } from "./edit-provider.types.ts";
import type { ImageMime } from "./image.types.ts";
import type { Usage } from "./limits.types.ts";

export type EditRecord = {
  id: string;
  userId: string;
  assetId: string;
  mime: ImageMime;
  model: string;
  size?: ImageSize; // the result's size class; "Edit more" keeps it (missing on older records)
  area?: boolean; // an edit of a highlighted area (saved by the app, pasted onto the original)
  createdAt: string;
  parentEditId: string | null;
  savedAssetId: string | null; // set once uploaded, so a retried save doesn't upload again
  saved: boolean; // set once fully saved (uploaded, dated, stacked)
};

// A checked POST /edits or /edits/area request (schemas/edits.schema.ts). `tools`: the app's
// presets picked for this edit, up to MAX_TOOLS ([] for a typed instruction); `prompt` is
// already their instructions and the typed words joined into one by the app. They pick the
// provider (services/edit-providers.service.ts). For an edit of a highlighted area: `mark`, the
// photo with that area tinted red, and `photo`, the photo itself upright as the app shows it (a
// first edit only; constants/edits.constants.ts), both decoded into files in the edit's folder
// as the request arrived.
export type EditRequest = {
  assetId: string;
  fromEditId: string | null;
  prompt: string;
  tools: string[];
  mark: EditMark | null;
  photo: EditMark | null;
};

// How an app lined a result up with the photo before pasting (POST /edits/:id/alignment), logged
// so the refusal threshold can be tuned on real edits.
export type AlignmentReport = {
  scaleX: number; offsetX: number; scaleY: number; offsetY: number; error: number; patches: number; refused: boolean;
};

export type EditMark = ImageFile & { mime: ImageMime };

// A new edit result (services/edits.service.ts), and the user's usage after it.
export type EditMade = { editId: string; size: ImageSize; usage: Usage };

// An edit result to show: its file, opened (the caller reads it to the end, which closes it), its
// size, and the name it downloads under.
export type EditImage = { record: EditRecord; file: FileHandle; size: number; filename: string };

// The image an edit starts from, in the edit's folder: the photo from Immich, the app's (a
// highlighted edit), or for "Edit more" the previous result.
export type EditSource = ImageFile & { from: "original" | "preview" | "app" | "edit" };
