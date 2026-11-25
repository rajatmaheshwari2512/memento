// AI edits and their limits (services/edits.service.ts, limits.service.ts).

import { COPY_TYPES, MAX_COPY_BYTES } from "../constants/copies.constants.ts";
import { FOUR_K_OVER_PIXELS, MAX_AREA_REQUEST_BYTES, UPDATE_THE_APP } from "../constants/edits.constants.ts";
import { MAX_JSON_BYTES } from "../constants/http.constants.ts";
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
import { HttpError } from "../utils/http-error.ts";
import { imageType, jsonRequest, log, readJson, receiveImage, send } from "../utils/http.ts";

const made = (res: ServerResponse, edit: EditMade | null) => {
  if (edit) send(res, 201, { editId: edit.editId, imageUrl: `edits/${edit.editId}/image`, size: edit.size, usage: edit.usage });
};

// Whether the person is still waiting for this edit: its connection is open. One that closed
// while the edit waited its turn or its photo was fetched (they left the page) isn't made: no
// call to Google, nothing counted.
function stillWanted(req: IncomingMessage, user: User): () => boolean {
  return () => {
    if (req.socket && !req.socket.destroyed) return true;
    log({ event: "edit_skipped", user: user.id });
    return false;
  };
}

// POST /edits with a highlighted area's images, from an app built before /edits/area: more
// than a whole-photo edit's few bytes. Said plainly instead of "too large", once the app has
// finished sending (read and dropped, up to the area request's cap), so it gets the answer.
// Its type, declared size and login are checked first (create), so only a logged-in app's
// request is read this way.
async function readEditRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(req.headers["content-length"] ?? "0") > MAX_JSON_BYTES) {
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_AREA_REQUEST_BYTES) break;
    }
    throw new HttpError(426, UPDATE_THE_APP);
  }
  try {
    return await readJson(req);
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) throw new HttpError(426, UPDATE_THE_APP);
    throw error;
  }
}

export const editsController = {
  // Your edits today, and everyone's this month; and above how many pixels a photo is edited at
  // 4K (if the admin allows it), so the apps show the price of the size it'll be made at.
  async limits(req, res) {
    const { user } = await requireUser(req);
    send(res, 200, { ...usage(user.id), fourKOverPixels: FOUR_K_OVER_PIXELS });
  },

  // A whole-photo edit, typed or with tools (refused with the AI tools switched off).
  async create(req, res) {
    jsonRequest(req, MAX_AREA_REQUEST_BYTES); // the JSON content type is also the cross-site guard
    const { user, cred } = await requireUser(req);
    const body = await readEditRequest(req);
    const flags = requireGemini();
    const request = parseEditRequest(body);
    if (request.tools.length > 0) requireTools(flags);
    const wanted = stillWanted(req, user);
    made(res, await inEditLine(async (folder) => (wanted() ? makeEdit(user, cred, flags, request, folder, wanted) : null)));
  },

  // An edit of a highlighted area: a bigger request (the mark and the upright photo), so its
  // type, declared size, the login and both switches are checked before it's read, and it's
  // read only in its turn, its images straight into the edit's folder.
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

  // Sent from disk as it's read.
  async image(req, res, { id }) {
    const { user } = await requireUser(req);
    const { record, file, size, filename } = await editImage(user, id!);
    res.writeHead(200, {
      "content-type": record.mime, // only JPEG, PNG or WebP ever get stored
      "content-length": size,
      "content-disposition": `inline; filename="${filename}"`,
    });
    await pipeline(file.createReadStream(), res);
  },

  // `{ whole: true }`: a highlighted edit's whole result, as the person chose.
  async save(req, res, { id }) {
    const body = await readJson(req); // the JSON content type is also the cross-site guard
    const { user, cred } = await requireUser(req);
    send(res, 200, { assetId: await saveEdit(user, cred, id!, body.whole === true) });
  },

  // An edit of a highlighted area, pasted onto the original by the app: the body is that photo
  // (image/jpeg or image/png, as for Adjust's save, also the cross-site guard). Everything is
  // checked before the upload is read, and its size against the photo's after.
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
