// What POST /edits and /edits/area accept, and the alignment an app reports
// (controllers/edits.controller.ts).

import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { config } from "../config.ts";
import { MARK_TYPES, MAX_AREA_REQUEST_BYTES, MAX_MARK_BYTES, MAX_PHOTO_BYTES, MAX_TOOLS } from "../constants/edits.constants.ts";
import type { AlignmentReport, EditMark, EditRequest } from "../types/edits.types.ts";
import { Base64ToFile } from "../utils/base64-file.ts";
import { HttpError, isUuid } from "../utils/http-error.ts";
import { readJsonStreamed } from "../utils/http.ts";
import { sniffImage } from "../utils/image-type.ts";

const TOOL_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const isToolName = (value: unknown): value is string => typeof value === "string" && TOOL_NAME.test(value);

// A whole-photo edit, typed or with tools.
export function parseEditRequest(body: Record<string, unknown>): EditRequest {
  const { assetId, fromEditId } = body;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!isUuid(assetId)) throw new HttpError(400, "assetId must be a photo ID.");
  if (fromEditId !== undefined && fromEditId !== null && !isUuid(fromEditId)) throw new HttpError(400, "fromEditId must be an edit ID.");
  const tools = parseTools(body);
  if (!prompt) throw new HttpError(400, "Say what to change.");
  if (prompt.length > config.maxPromptChars) throw new HttpError(400, `Keep the instruction under ${config.maxPromptChars} characters.`);
  return {
    assetId,
    fromEditId: typeof fromEditId === "string" ? fromEditId : null,
    prompt,
    tools,
    mark: null,
    photo: null,
  };
}

// The tools picked: `tools`, 1 to MAX_TOOLS different names; or from an app built before
// several could be picked, `tool`, one name. Neither: a typed instruction ([]). Only the count
// and the names are checked: which tools go together is the apps' rule (ai-tools.json).
function parseTools(body: Record<string, unknown>): string[] {
  const { tool, tools } = body;
  const sent = (value: unknown) => value !== undefined && value !== null;
  if (sent(tool) && sent(tools)) throw new HttpError(400, "Send tools or tool, not both.");
  if (sent(tool)) {
    if (!isToolName(tool)) throw new HttpError(400, "tool must be a tool's name.");
    return [tool];
  }
  if (!sent(tools)) return [];
  if (
    !Array.isArray(tools) || tools.length < 1 || tools.length > MAX_TOOLS || !tools.every(isToolName) ||
    new Set(tools).size !== tools.length
  ) {
    throw new HttpError(400, `tools must be 1 to ${MAX_TOOLS} different tools' names.`);
  }
  return tools;
}

// An edit of a highlighted area, read as it arrives: the mark and the photo (base64 strings) are
// decoded into files in the edit's folder as they come, never whole in memory; the rest is a
// /edits request's few fields. Then checked as parseAreaRequest says.
export async function readAreaRequest(req: IncomingMessage, folder: string): Promise<EditRequest> {
  const images = new Map<string, Base64ToFile>();
  let files = 0; // each image gets its own file, even if a field repeats
  try {
    const body = await readJsonStreamed(req, MAX_AREA_REQUEST_BYTES, AREA_IMAGES, (name) => {
      const image = new Base64ToFile(join(folder, `${name}-${files++}`), { strict: true, maxBytes: AREA_IMAGES_MAX[name]! });
      images.set(name, image);
      return image;
    });
    return parseAreaRequest(body, images);
  } finally {
    for (const image of images.values()) await image.close();
  }
}

const AREA_IMAGES_MAX: Record<string, number> = { mark: MAX_MARK_BYTES, photo: MAX_PHOTO_BYTES };
const AREA_IMAGES: ReadonlySet<string> = new Set(Object.keys(AREA_IMAGES_MAX));

// Also the mark, and for a first edit the upright photo; checked in the same order as ever (the
// request's fields first, then the mark, then the photo).
function parseAreaRequest(body: Record<string, unknown>, images: ReadonlyMap<string, Base64ToFile>): EditRequest {
  const request = parseEditRequest(body);
  const mark = parseImage(body.mark, images.get("mark"), "mark");
  const photo = parseImage(body.photo, images.get("photo"), "photo");
  if (!mark) throw new HttpError(400, "A highlighted edit needs the mark (the photo with the area tinted red).");
  if (!photo && request.fromEditId === null) throw new HttpError(400, "A highlighted edit needs the photo, upright as the app shows it.");
  return { ...request, mark, photo };
}

// An image, base64 (a string, decoded into `file` as it came): a JPEG, PNG or WebP by its bytes,
// not too big. Not sent (or null): none.
function parseImage(value: unknown, file: Base64ToFile | undefined, name: string): EditMark | null {
  if (!file) {
    if (value === undefined || value === null) return null;
    throw new HttpError(400, `${name} must be an image, base64-encoded.`);
  }
  if (!file.valid) throw new HttpError(400, `${name} must be an image, base64-encoded.`);
  if ((file.chars * 3) / 4 > AREA_IMAGES_MAX[name]! + 2) throw new HttpError(413, `The ${name} is too large.`);
  const mime = sniffImage(file.head);
  if (!mime || !MARK_TYPES.has(mime)) throw new HttpError(415, `The ${name} must be a JPEG, PNG or WebP image.`);
  return { path: file.path, mime, bytes: file.bytes };
}

// Numbers only, each within reason.
export function parseAlignmentReport(body: Record<string, unknown>): AlignmentReport {
  const number = (name: string, min: number, max: number) => {
    const value = body[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new HttpError(400, `${name} must be a number.`);
    return value;
  };
  if (typeof body.refused !== "boolean") throw new HttpError(400, "refused must be true or false.");
  return {
    scaleX: number("scaleX", 0.5, 2), offsetX: number("offsetX", -1, 1), scaleY: number("scaleY", 0.5, 2), offsetY: number("offsetY", -1, 1),
    error: number("error", 0, 1), patches: Math.round(number("patches", 0, 10_000)), refused: body.refused,
  };
}
