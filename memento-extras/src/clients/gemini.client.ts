// Sends a photo and an instruction to Gemini and returns the edited image. For an edit of a
// highlighted area, a second image marks the area (constants/edits.constants.ts, AREA_GUIDANCE).
// Uses Google's Interactions API (POST /v1beta/interactions), the one Google's
// image docs use since 2026. Only the image and the text are sent: never the user's
// Immich login, name or the photo's location.
//
// No image is ever whole in memory (constants/edits.constants.ts, EDITS_AT_ONCE): the request's
// images are read from their files and sent as base64 a piece at a time, and the reply is read as
// it arrives, its image decoded straight into a file in the edit's folder.
//
// It's one edit provider (types/edit-provider.types.ts); services/edit-providers.service.ts
// chooses which provider makes each edit.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import {
  API_REVISION, AREA_GUIDANCE, GEMINI_TIMEOUT_MS, GUIDANCE, MAX_ERROR_REPLY_BYTES, MAX_REPLY_BYTES, MAX_REPLY_KEPT_BYTES,
  MAX_REPLY_TEXT_BYTES,
} from "../constants/edits.constants.ts";
import type { EditInput, EditOutput, EditProvider, ImageFile } from "../types/edit-provider.types.ts";
import type { GeminiReply } from "../types/gemini.types.ts";
import { Base64ToFile, base64Length, base64OfFile } from "../utils/base64-file.ts";
import { HttpError } from "../utils/http-error.ts";
import { sniffImage } from "../utils/image-type.ts";
import { readJsonStream, type JsonPath, type JsonRoute } from "../utils/json-stream.ts";

const URL = config.geminiUrl;

// Gemini answered without an image. Its message is for the person, not the log.
export class GeminiRefused extends HttpError {
  constructor(message: string) {
    super(422, message);
  }
}

async function geminiEdit(input: EditInput): Promise<EditOutput> {
  const body = await requestBody([
    `{"model":${JSON.stringify(config.geminiModel)},"store":false,"input":[`,
    JSON.stringify({ type: "text", text: (input.mark ? AREA_GUIDANCE : GUIDANCE) + input.prompt }),
    ",",
    ...imagePart(input.image),
    // An edit of a highlighted area: the same photo with that area tinted red.
    ...(input.mark ? [",", ...imagePart(input.mark)] : []),
    // No aspect_ratio: the result keeps the photo's shape.
    `],"response_format":${JSON.stringify({ type: "image", image_size: input.size, mime_type: "image/jpeg" })}}`,
  ]);

  let res: Response;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: {
        "x-goog-api-key": config.geminiApiKey, "content-type": "application/json", "api-revision": API_REVISION,
        // Its exact length, as for any request whose body is known whole: sent as it's read.
        "content-length": String(body.length),
      },
      body: body.stream,
      duplex: "half",
      // Otherwise fetch keeps everything sent in memory until Google answers, in case it has to
      // send it again after a redirect (measured: the whole request). Google doesn't redirect it.
      redirect: "error",
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    } as RequestInit);
  } catch (error) {
    console.error(JSON.stringify({ event: "gemini_unreachable", error: String(error) }));
    throw new HttpError(502, "Couldn't reach Google. Try again in a moment.");
  }

  if (!res.ok) {
    // Only the status and Google's error code: its message can quote the request.
    const code = await errorCode(res);
    console.error(JSON.stringify({ event: "gemini_error", status: res.status, code: typeof code === "string" ? code.slice(0, 40) : null }));
    if (res.status === 402) throw new HttpError(503, "AI editing is paused: the Google prepaid credit is used up.");
    if (res.status === 429) throw new HttpError(503, "Google is busy right now. Try again in a minute.");
    if (res.status === 400) throw new HttpError(422, "Google couldn't process this photo or instruction.");
    throw new HttpError(502, `Google returned an error (${res.status}).`);
  }

  const reply = await readReply(res, input.folder);
  const { image, said } = resultOf(reply);
  if (!image) {
    // Usually a refusal; the model says why in its text, which is shown to the person but never
    // logged (it can repeat their instruction).
    console.error(JSON.stringify({ event: "gemini_no_image", status: reply.status, reason: said ? "refused_with_text" : "no_image" }));
    throw new GeminiRefused(said ? `Gemini didn't make an image: ${said.slice(0, 300)}` : "Gemini didn't return an image. Try rewording the instruction.");
  }

  const mime = sniffImage(image.head);
  if (!mime) throw new HttpError(502, "Gemini returned something that isn't a JPEG, PNG or WebP image.");
  return { image: { path: image.path, mime, bytes: image.bytes }, model: config.geminiModel, costUsd: config.costUsd[input.size] };
}

// An image in the request: its base64 comes from its file.
const imagePart = (file: ImageFile): Array<string | ImageFile> => [
  `{"type":"image","mime_type":${JSON.stringify(file.mime)},"data":"`, file, `"}`,
];

// The request's JSON, written exactly as JSON.stringify would, from text and image files: its
// length up front, and the bytes as they're sent (each image read from its file, 48 KB at a time).
async function requestBody(parts: Array<string | ImageFile>): Promise<{ length: number; stream: ReadableStream<Uint8Array> }> {
  let length = 0;
  for (const part of parts) length += typeof part === "string" ? Buffer.byteLength(part) : base64Length((await stat(part.path)).size);
  async function* bytes(): AsyncGenerator<Uint8Array> {
    for (const part of parts) {
      if (typeof part === "string") yield Buffer.from(part);
      else yield* base64OfFile(part.path);
    }
  }
  const pieces = bytes();
  const stream = new ReadableStream<Uint8Array>({
    // A piece only when the connection takes the last one.
    async pull(controller) {
      const next = await pieces.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await pieces.return(undefined); // closes the file being read
    },
  });
  return { length, stream };
}

// Reads Gemini's reply as it arrives (utils/json-stream.ts), keeping only what's needed: the
// status, and each content's type, text (cut at MAX_REPLY_TEXT_BYTES) and image type. Every
// image's base64 `data` is decoded into a file in `folder` as it comes; which one is the result is
// decided once the whole reply is in, as before (keys can come in any order). Exported for the
// tests.
export async function readReply(res: Response, folder: string): Promise<GeminiReply> {
  const images = new Map<string, Base64ToFile>(); // by "step/content"
  let files = 0; // each image gets its own file, even if a key repeats
  try {
    const reply = await readJsonStream(bodyOf(res), {
      route: replyRoute,
      sink: (path) => {
        const image = new Base64ToFile(join(folder, `result-${files++}`), { strict: false, maxBytes: Infinity });
        images.set(`${path[1]}/${path[3]}`, image);
        return image;
      },
      maxBytes: MAX_REPLY_BYTES,
      maxKeptBytes: MAX_REPLY_KEPT_BYTES,
      maxStringBytes: MAX_REPLY_TEXT_BYTES,
      tooLarge: () => {
        console.error(JSON.stringify({ event: "gemini_reply_too_large", maxBytes: MAX_REPLY_BYTES }));
        return new HttpError(502, "Google's answer was too large.");
      },
      invalid: () => new SyntaxError("Gemini's reply isn't valid JSON."),
    }) as { status?: unknown; steps?: unknown } | undefined;
    const steps = Array.isArray(reply?.steps) ? reply.steps : [];
    const contents = steps.flatMap((step: { content?: unknown } | undefined, i) => {
      const content = step?.content;
      if (!Array.isArray(content)) return [];
      return content.map((c: { type?: unknown; text?: unknown } | undefined, j) => ({ type: c?.type, text: c?.text, image: images.get(`${i}/${j}`) }));
    });
    return { status: reply?.status, contents };
  } finally {
    for (const image of images.values()) await image.close();
  }
}

// The result: the last image of all the steps' contents, if the interaction completed; and what
// the model said (its texts, joined). Exported for the tests.
export function resultOf(reply: GeminiReply): { image: Base64ToFile | null; said: string } {
  const image = reply.contents.filter((c) => c.type === "image" && c.image).at(-1)?.image;
  const said = reply.contents.filter((c) => c.type === "text" && c.text).map((c) => c.text).join(" ").trim();
  return { image: reply.status === "completed" && image && image.chars > 0 ? image : null, said };
}

// { status, steps: [{ content: [{ type, text, mime_type, data }] }] }: the rest is skipped.
function replyRoute(path: JsonPath): JsonRoute {
  switch (path.length) {
    case 0:
      return "open";
    case 1:
      return path[0] === "status" ? "keep" : path[0] === "steps" ? "open" : "skip";
    case 2: // a step
      return "open";
    case 3:
      return path[2] === "content" ? "open" : "skip";
    case 4: // a content
      return "open";
    case 5:
      return path[4] === "data" ? "stream" : path[4] === "type" || path[4] === "text" || path[4] === "mime_type" ? "keep" : "skip";
    default:
      return "skip";
  }
}

// The error code in a failed request's answer ({ error: { status } }), if it's there.
async function errorCode(res: Response): Promise<unknown> {
  try {
    const reply = await readJsonStream(bodyOf(res), {
      route: (path) => (path.length === 0 || (path.length === 1 && path[0] === "error") ? "open" : path.length === 2 && path[1] === "status" ? "keep" : "skip"),
      sink: () => {
        throw new Error("nothing is streamed");
      },
      maxBytes: MAX_ERROR_REPLY_BYTES,
      maxKeptBytes: MAX_ERROR_REPLY_BYTES,
      tooLarge: () => new Error("too large"),
      invalid: () => new Error("not JSON"),
    }) as { error?: { status?: unknown } } | undefined;
    return reply?.error?.status ?? null;
  } catch {
    await res.body?.cancel().catch(() => {});
    return null; // not JSON, or too large to bother with
  }
}

const bodyOf = (res: Response): AsyncIterable<Uint8Array> => (res.body ?? []) as AsyncIterable<Uint8Array>;

export const gemini: EditProvider = { name: "gemini", model: config.geminiModel, edit: geminiEdit };
