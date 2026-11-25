// Which provider makes an AI edit (types/edit-provider.types.ts): the one place it's chosen.
// Each request names the tools picked (the apps' preset ids, from
// immich/web/src/lib/ai-edit/ai/ai-tools.json; none for a typed instruction). Today every tool uses
// Gemini. To add a provider later: write its client with the same shape as gemini.client.ts,
// list it in PROVIDERS, and point the tools it should make at it in BY_TOOL. Only an edit of a
// single tool goes to that tool's provider; several tools combined into one instruction go to
// Gemini. The apps send the same request and paste back and save the result the same way; they
// show no price, so nothing changes in them.

import { gemini } from "../clients/gemini.client.ts";
import type { EditProvider } from "../types/edit-provider.types.ts";

const PROVIDERS = { gemini } satisfies Record<string, EditProvider>;

// Tools made by another provider than Gemini. None yet.
const BY_TOOL: Record<string, keyof typeof PROVIDERS> = {};

export function providerFor(tools: readonly string[]): EditProvider {
  return PROVIDERS[(tools.length === 1 ? BY_TOOL[tools[0]!] : undefined) ?? "gemini"];
}
