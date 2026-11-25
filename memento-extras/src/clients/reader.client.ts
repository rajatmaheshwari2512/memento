// The trained question reader (memento-extras/reader/, its own container): labels each word
// of a question. Any failure, a reply that doesn't fit, or a slow answer gives null, and Ask
// searches the question as it is instead (services/ask.service.ts). The question isn't logged.

import { config } from "../config.ts";
import { READER_LABEL } from "../constants/ask.constants.ts";
import type { ReaderReply } from "../types/ask.types.ts";
import { log } from "../utils/http.ts";

export async function readQuestion(question: string): Promise<ReaderReply | null> {
  const started = Date.now();
  try {
    const res = await fetch(`${config.readerUrl}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(config.readerTimeoutMs),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as Partial<ReaderReply>;
    const { tokens, tags } = body;
    if (!Array.isArray(tokens) || !Array.isArray(tags) || tokens.length !== tags.length) throw new Error("reply doesn't fit");
    if (!tokens.every((t) => typeof t === "string") || !tags.every((t) => typeof t === "string" && READER_LABEL.test(t))) throw new Error("reply doesn't fit");
    return { tokens, tags };
  } catch (error) {
    log({ event: "reader_unavailable", ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
