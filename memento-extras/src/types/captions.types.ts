// Captions: what the model is asked for and what's kept.

import type { TAGS } from "../constants/captions.constants.ts";

export type Tag = (typeof TAGS)[number];

export type Caption = { caption: string; tags: Tag[] };

// One finished caption, as a line of the backlog's results file and as imported.
export type CaptionRecord = Caption & {
  assetId: string;
  ownerId: string;
  model: string;
};

// A photo to caption, from the list exported from Immich's database: asset ID, owner ID, type, preview path and optionally when it was uploaded; one per line, tab-separated.
export type PhotoToCaption = { id: string; ownerId: string; path: string; uploadedAt: string };

export type Reply = {
  choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export type CaptionResult = CaptionRecord & { seconds: number; promptTokens?: number; completionTokens?: number };

export type CaptionMatch = { assetId: string; caption: string; tags: Tag[] };

// What a night's clean-up found and did, and what an import did (caption-records.service.ts).
export type GoneCaptions = { gone: number; removed: boolean };
export type ImportResult = { imported: number; skipped: number; total: number };
