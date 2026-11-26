// Which provider makes an AI edit (types/edit-provider.types.ts). Today every tool uses Gemini. To add a provider: write its client with the same shape as gemini.client.ts, list it in PROVIDERS, and point its tools at it in BY_TOOL.

import { gemini } from "../clients/gemini.client.ts";
import type { EditProvider } from "../types/edit-provider.types.ts";

const PROVIDERS = { gemini } satisfies Record<string, EditProvider>;

// Tools made by another provider than Gemini. None yet.
const BY_TOOL: Record<string, keyof typeof PROVIDERS> = {};

export function providerFor(tools: readonly string[]): EditProvider {
  return PROVIDERS[(tools.length === 1 ? BY_TOOL[tools[0]!] : undefined) ?? "gemini"];
}
