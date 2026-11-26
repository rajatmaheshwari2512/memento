// The one place an AI edit request is offered to a free tool before Gemini is paid for. Called by makeEdit (edits.service.ts) after the photo is checked and before a slot is reserved. Today there are no free tools, so every request goes on to Gemini.

import type { EditMade, EditRequest } from "../types/edits.types.ts";
import type { Asset, User } from "../types/immich.types.ts";

// A free tool's result for this request, or null to go on to Gemini.
export async function tryFreeTool(_user: User, _photo: Asset, _request: EditRequest): Promise<EditMade | null> {
  return null;
}
