// Adjust's save (services/adjust.service.ts).

import { COPY_TYPES, MAX_COPY_BYTES } from "../constants/copies.constants.ts";
import { requireUser } from "../middleware/auth.middleware.ts";
import { adjustableOriginal, requireAdjust, saveAdjusted } from "../services/adjust.service.ts";
import { withSaveSlot } from "../services/copies.service.ts";
import type { Handler } from "../types/http.types.ts";
import { imageType, receiveImage, send } from "../utils/http.ts";

export const adjustController = {
  // The body is the adjusted photo itself (Content-Type image/jpeg or image/png). Like
  // JSON, those types can't be sent from another site without the browser asking first,
  // so they're the cross-site guard here. Everything is checked before the upload is read.
  async save(req, res, { id }) {
    const mime = imageType(req, COPY_TYPES, MAX_COPY_BYTES);
    const { user, cred } = await requireUser(req);
    requireAdjust();
    const original = await adjustableOriginal(user, cred, id!);
    const assetId = await withSaveSlot(async (path) => {
      await receiveImage(req, mime, MAX_COPY_BYTES, path);
      return saveAdjusted(user, cred, original, path, mime);
    });
    send(res, 200, { assetId });
  },
} satisfies Record<string, Handler>;
