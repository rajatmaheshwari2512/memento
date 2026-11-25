// Is it running (for Docker; no login needed).

import type { Handler } from "../types/http.types.ts";
import { send } from "../utils/http.ts";

export const healthController = {
  get: async (_req, res) => send(res, 200, { ok: true }),
} satisfies Record<string, Handler>;
