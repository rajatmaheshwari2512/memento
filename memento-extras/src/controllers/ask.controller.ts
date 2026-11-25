// Ask Photos: a question in plain English → matching photos (services/ask.service.ts).

import { requireUser } from "../middleware/auth.middleware.ts";
import { parseAskRequest } from "../schemas/ask.schema.ts";
import { ask, requireAskPhotos } from "../services/ask.service.ts";
import type { Handler } from "../types/http.types.ts";
import { readJson, send } from "../utils/http.ts";

export const askController = {
  async ask(req, res) {
    const body = await readJson(req); // the JSON content type is also the cross-site guard
    const { user, cred } = await requireUser(req);
    requireAskPhotos();
    send(res, 200, await ask(user, cred, parseAskRequest(body)));
  },
} satisfies Record<string, Handler>;
