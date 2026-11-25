// "Free first" (FEATURES.md section 5, "Free first, always"; DECISIONS.md, "Free open models
// first, Gemini only when you tap"): the one place an AI edit request is offered to a free
// tool before Gemini is paid for. Called by makeEdit (edits.service.ts) after the photo is
// checked and before a slot is reserved under the limits, so a request answered here never
// counts as an AI edit and never reaches Google.
//
// Today there are no free tools (they run on the worker, which isn't set up yet), so every
// request goes on to Gemini. When the worker exists, this is where:
//   - a typed instruction is read by the worker's small model (the Ask Photos one) and
//     mapped to a free tool when one can do it: "brighter"/"warmer" → Adjust's sliders, set
//     to values; "remove the person" with a highlight → LaMa; "blur the background" → depth
//     blur; "black and white except me" → colour pop; "sharpen" → the deblur model;
//   - the free result is returned in place of Gemini's (an EditMade with no cost), and the
//     apps show it with "Try with Gemini (~₹5)" next to it. Anything else goes on to Gemini,
//     whose price the apps show before the request is sent.

import type { EditMade, EditRequest } from "../types/edits.types.ts";
import type { Asset, User } from "../types/immich.types.ts";

// A free tool's result for this request, or null to go on to Gemini.
export async function tryFreeTool(_user: User, _photo: Asset, _request: EditRequest): Promise<EditMade | null> {
  return null; // no worker yet: everything goes to Gemini
}
