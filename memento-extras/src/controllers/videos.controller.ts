// Reduce noise for videos (services/reduce-noise.service.ts).

import { requireUser } from "../middleware/auth.middleware.ts";
import { noiseStatus, requestReduceNoise } from "../services/reduce-noise.service.ts";
import type { Handler } from "../types/http.types.ts";
import { readJson, send } from "../utils/http.ts";

export const videosController = {
  async reduceNoise(req, res, { assetId }) {
    await readJson(req);
    const { user, cred } = await requireUser(req);
    send(res, 202, await requestReduceNoise(user, cred, assetId!));
  },

  async job(req, res, { id }) {
    const { user } = await requireUser(req);
    send(res, 200, noiseStatus(user, id!));
  },
} satisfies Record<string, Handler>;
