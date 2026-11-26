// Small helpers shared by the routes: JSON responses, reading JSON bodies, logging.

import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { MAX_JSON_BYTES } from "../constants/http.constants.ts";
import type { ImageMime } from "../types/image.types.ts";
import { HttpError } from "./http-error.ts";
import { sniffImage } from "./image-type.ts";
import { readJsonStream, type StringSink } from "./json-stream.ts";

export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

export function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) }).end(json);
}

// A JSON request's declared type and size, checked before anything else.
export function jsonRequest(req: IncomingMessage, maxBytes = MAX_JSON_BYTES): void {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Send the request as JSON (Content-Type: application/json).");
  if (Number(req.headers["content-length"] ?? "0") > maxBytes) throw new HttpError(413, "Request too large.");
}

// The JSON body, read as it arrives and refused once it passes `maxBytes` (16 KB unless a
// route allows more, e.g. an AI edit with its marked copy).
export async function readJson(req: IncomingMessage, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  jsonRequest(req, maxBytes);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "Request too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
}

// Like readJson, but the top-level strings named in `streamed` (an image in base64, say) go to their sinks as they arrive instead of into memory. Streamed strings aren't in the object returned.
export async function readJsonStreamed(
  req: IncomingMessage, maxBytes: number, streamed: ReadonlySet<string>, sink: (name: string) => StringSink,
): Promise<Record<string, unknown>> {
  jsonRequest(req, maxBytes);
  const notJson = () => new HttpError(400, "The request body isn't valid JSON.");
  const body = await readJsonStream(req, {
    route: (path) => (path.length === 0 ? "open" : path.length === 1 && streamed.has(String(path[0])) ? "stream" : "keep"),
    sink: (path) => sink(String(path[0])),
    maxBytes,
    maxKeptBytes: MAX_JSON_BYTES,
    tooLarge: () => new HttpError(413, "Request too large."),
    invalid: notJson,
  });
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw notJson();
  return body as Record<string, unknown>;
}

// An image upload's declared type, if it's one of `allowed`.
export function imageType<T extends ImageMime>(req: IncomingMessage, allowed: readonly T[], maxBytes: number): T {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const mime = allowed.find((a) => a === type);
  if (!mime) throw new HttpError(415, `Send the photo as ${allowed.join(" or ")}.`);
  if (Number(req.headers["content-length"] ?? "0") > maxBytes) throw new HttpError(413, tooLarge(maxBytes));
  return mime;
}

// Streams the upload to `path` (a new file, readable only by this service): at most
// `maxBytes`, and really of type `mime` (checked by its first bytes, before more is written).
export async function receiveImage(req: IncomingMessage, mime: ImageMime, maxBytes: number, path: string): Promise<void> {
  let size = 0;
  let head = Buffer.alloc(0);
  const checked = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, tooLarge(maxBytes));
      if (head.length < SNIFF_BYTES) {
        head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES);
        if (head.length === SNIFF_BYTES && sniffImage(head) !== mime) throw notType(mime);
      }
      yield chunk;
    }
    if (sniffImage(head) !== mime) throw notType(mime);
  };
  const file = await open(path, "wx", 0o600);
  await pipeline(req, checked, file.createWriteStream());
}

// Enough of a file to tell JPEG, PNG and WebP apart (utils/image-type.ts).
const SNIFF_BYTES = 12;

const notType = (mime: ImageMime) => new HttpError(415, `That isn't a ${mime === "image/png" ? "PNG" : "JPEG"} file.`);

const tooLarge = (maxBytes: number) => `This photo is too large to save (over ${Math.round(maxBytes / 1024 / 1024)} MB).`;
