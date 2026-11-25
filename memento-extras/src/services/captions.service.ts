// Captions: a one-line description and a few tags for each photo, written by a small open
// vision model (FEATURES.md, "Captions and tags"; DECISIONS.md, "Captions go in our own
// database"). They feed Ask Photos' search later.
//
// This file asks the model for one photo's caption. It's shared by everything that captions
// photos: the one-off backlog (scripts/caption-backlog.ts) and new photos at night
// (scripts/caption-night.ts), so old and new captions are made the same way. What we ask
// and the tag list: constants/captions.constants.ts; what we accept:
// schemas/captions.schema.ts. It doesn't read settings or the database, so the backlog
// script can run on its own. Storage and search are in repositories/captions.repository.ts.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PROMPT } from "../constants/captions.constants.ts";
import { parseCaption, SCHEMA } from "../schemas/captions.schema.ts";
import type { CaptionResult, PhotoToCaption, Reply } from "../types/captions.types.ts";

// The body for llama-server's OpenAI-style POST /v1/chat/completions.
export function captionRequest(jpeg: Buffer, model?: string): Record<string, unknown> {
  return {
    ...(model ? { model } : {}),
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "caption", schema: SCHEMA } },
    // Some of these models "think" first by default, which is slow and uses up the reply.
    chat_template_kwargs: { enable_thinking: false },
    temperature: 0.2,
    max_tokens: 200,
  };
}

export function readPhotoList(file: string): PhotoToCaption[] {
  const photos: PhotoToCaption[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [id, ownerId, , path, uploadedAt] = line.trim().split("\t");
    if (id && ownerId && path) photos.push({ id, ownerId, path, uploadedAt: uploadedAt ?? "" });
  }
  return photos;
}

// The model's name as llama-server reports it, recorded with each caption.
export async function modelName(url: string): Promise<string> {
  const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}/v1/models answered ${res.status}`);
  const data = (await res.json()) as { data?: { id?: unknown }[] };
  const id = data.data?.[0]?.id;
  return typeof id === "string" && id !== "" ? id.split("/").pop()! : "unknown";
}

// One photo's preview → llama-server → a checked caption. Throws when it can't be had:
// the error's message is only the kind of failure, safe to log; its cause can quote the
// model's reply, i.e. the photo's description.
export async function captionPhoto(url: string, model: string, photo: PhotoToCaption, timeoutMs: number): Promise<CaptionResult> {
  const jpeg = await readFile(photo.path);
  const started = performance.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(captionRequest(jpeg)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const seconds = Math.round(performance.now() - started) / 1000;
  if (!res.ok) throw new Error(`llama-server answered ${res.status}`, { cause: (await res.text()).slice(0, 200) });
  const reply = (await res.json()) as Reply;
  const message = reply.choices?.[0]?.message;
  // A model that "thinks" first is several times slower; thinking must be off.
  if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim() !== "") {
    throw new Error("the model thought before answering; turn thinking off");
  }
  const caption = parseCaption(message?.content);
  if (!caption) throw new Error("unusable reply", { cause: String(message?.content).slice(0, 200) });
  return {
    assetId: photo.id,
    ownerId: photo.ownerId,
    model,
    ...caption,
    seconds,
    promptTokens: reply.usage?.prompt_tokens,
    completionTokens: reply.usage?.completion_tokens,
  };
}

