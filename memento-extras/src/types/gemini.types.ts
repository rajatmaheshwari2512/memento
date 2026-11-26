// Gemini's Interactions API reply as read while it arrives: the status, and each step's contents in order (type, text, and for an image the file it was decoded into).

import type { Base64ToFile } from "../utils/base64-file.ts";

export type GeminiReply = {
  status: unknown;
  contents: Array<{ type: unknown; text: unknown; image: Base64ToFile | undefined }>;
};
