// What the caption model must answer, and the checks every caption passes before
// it's kept (services/captions.service.ts, repositories/captions.repository.ts).

import { MAX_CAPTION_CHARS, MAX_TAGS, TAGS } from "../constants/captions.constants.ts";
import type { Caption, CaptionRecord, Tag } from "../types/captions.types.ts";
import { isUuid } from "../utils/http-error.ts";

// Makes the model's reply valid JSON of this shape (llama-server turns it into a grammar).
// The checker below still validates everything, in case a server ignores it.
export const SCHEMA = {
  type: "object",
  properties: {
    caption: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: [...TAGS] }, maxItems: MAX_TAGS },
  },
  required: ["caption", "tags"],
  additionalProperties: false,
};

const TAG_BY_LOWER = new Map(TAGS.map((t) => [t.toLowerCase(), t] as const));

// The model's reply text → a caption we accept, or null. Tags not on the list are dropped,
// and the caption is tidied and capped. Never throws.
export function parseCaption(text: unknown): Caption | null {
  if (typeof text !== "string") return null;
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { caption, tags } = data as { caption?: unknown; tags?: unknown };
  if (typeof caption !== "string") return null;
  let clean = caption.replace(/\s+/g, " ").trim();
  if (clean.length < 3) return null;
  if (clean.length > MAX_CAPTION_CHARS) clean = clean.slice(0, MAX_CAPTION_CHARS).replace(/\s+\S*$/, "") + "…";
  const chosen: Tag[] = [];
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const tag = typeof t === "string" ? TAG_BY_LOWER.get(t.trim().toLowerCase()) : undefined;
      if (tag && !chosen.includes(tag)) chosen.push(tag);
      if (chosen.length === MAX_TAGS) break;
    }
  }
  return { caption: clean, tags: chosen };
}

// A results-file line → a record, re-checked with the same rules. Null if anything's off.
export function parseRecord(line: string): CaptionRecord | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { assetId, ownerId, model } = data;
  if (!isUuid(assetId)) return null;
  if (!isUuid(ownerId)) return null;
  if (typeof model !== "string" || model === "") return null;
  const caption = parseCaption(JSON.stringify({ caption: data.caption, tags: data.tags }));
  return caption && { assetId, ownerId, model, ...caption };
}
