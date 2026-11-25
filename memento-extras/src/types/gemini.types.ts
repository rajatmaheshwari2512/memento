// Google's Gemini image editing (clients/gemini.client.ts): what its Interactions API answers,
// as read while it arrives: the status, and each step's content in order, with its type, its text
// and, for an image, the file its base64 was decoded into.

import type { Base64ToFile } from "../utils/base64-file.ts";

export type GeminiReply = {
  status: unknown;
  contents: Array<{ type: unknown; text: unknown; image: Base64ToFile | undefined }>;
};
