// AI edits and their limits (services/edits.service.ts, limits.service.ts).

import { COPY_TYPES, MAX_COPY_BYTES } from "../constants/copies.constants.ts";
import { FOUR_K_OVER_PIXELS, MAX_AREA_REQUEST_BYTES } from "../constants/edits.constants.ts";
import { requireUser } from "../middleware/auth.middleware.ts";
import { parseAlignmentReport, parseEditRequest, readAreaRequest } from "../schemas/edits.schema.ts";
import {
  discardEdit, editImage, inEditLine, logAlignment, makeEdit, requireGemini, requireTools, saveAreaEdit, saveEdit,
} from "../services/edits.service.ts";
import { usage } from "../services/limits.service.ts";
import type { EditMade } from "../types/edits.types.ts";
import type { Handler } from "../types/http.types.ts";
import type { User } from "../types/immich.types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { imageType, jsonRequest, log, readJson, receiveImage, send } from "../utils/http.ts";

const made = (res: ServerResponse, edit: EditMade | null) => {
  if (edit) send(res, 201, { editId: edit.editId, imageUrl: `edits/${edit.editId}/image`, size: edit.size, usage: edit.usage });
};

// Whether the person is still waiting for this edit (its connection is open).
function stillWanted(req: IncomingMessage, user: User): () => boolean {
  return () => {
    if (req.socket && !req.socket.destroyed) return true;
    log({ event: "edit_skipped", user: user.id });
    return false;
  };
}

export const editsController = {
  // Your edits today, and everyone's this month; and above how many pixels a photo is edited at 4K.
  async limits(req, res) {
    const { user } = await requireUser(req);
    send(res, 200, { ...usage(user.id), fourKOverPixels: FOUR_K_OVER_PIXELS });
  },

  // A whole-photo edit, typed or with tools (refused with the AI tools switched off).
  async create(req, res) {
    jsonRequest(req, MAX_AREA_REQUEST_BYTES);
    const { user, cred } = await requireUser(req);
    const body = await readJson(req);
    const flags = requireGemini();
    const request = parseEditRequest(body);
    if (request.tools.length > 0) requireTools(flags);
    const wanted = stillWanted(req, user);
    made(res, await inEditLine(async (folder) => (wanted() ? makeEdit(user, cred, flags, request, folder, wanted) : null)));
  },

  // An edit of a highlighted area (the mark and the upright photo).
  async createArea(req, res) {
    jsonRequest(req, MAX_AREA_REQUEST_BYTES);
    const { user, cred } = await requireUser(req);
    const flags = requireGemini();
    requireTools(flags);
    const wanted = stillWanted(req, user);
    made(
      res,
      await inEditLine(async (folder) => (wanted() ? makeEdit(user, cred, flags, await readAreaRequest(req, folder), folder, wanted) : null)),
    );
  },

  async image(req, res, { id }) {
    const { user } = await requireUser(req);
    const { record, file, size, filename } = await editImage(user, id!);
    res.writeHead(200, {
      "content-type": record.mime,
      "content-length": size,
      "content-disposition": `inline; filename="${filename}"`,
    });
    await pipeline(file.createReadStream(), res);
  },

  // `{ whole: true }`: a highlighted edit's whole result, as the person chose.
  async save(req, res, { id }) {
    const body = await readJson(req);
    const { user, cred } = await requireUser(req);
    send(res, 200, { assetId: await saveEdit(user, cred, id!, body.whole === true) });
  },

  // An edit of a highlighted area pasted onto the original by the app: the body is that photo (image/jpeg or image/png).
  async saveArea(req, res, { id }) {
    const mime = imageType(req, COPY_TYPES, MAX_COPY_BYTES);
    const { user, cred } = await requireUser(req);
    requireTools(requireGemini());
    const assetId = await saveAreaEdit(user, cred, id!, mime, (path) => receiveImage(req, mime, MAX_COPY_BYTES, path));
    send(res, 200, { assetId });
  },

  // How the app lined a highlighted edit's result up with the photo (numbers only), for the log.
  async alignment(req, res, { id }) {
    const body = await readJson(req);
    const { user } = await requireUser(req);
    await logAlignment(user, id!, parseAlignmentReport(body));
    send(res, 204);
  },

  async discard(req, res, { id }) {
    await readJson(req);
    const { user } = await requireUser(req);
    await discardEdit(user, id!);
    send(res, 204);
  },
} satisfies Record<string, Handler>;
