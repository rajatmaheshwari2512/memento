// Themed memories. Turning them on or off creates or deletes a key in the person's name, so
// changes need a logged-in app or browser, not an API key.

import { requireSessionUser, requireUser } from "../middleware/auth.middleware.ts";
import { parseRunOptions, parseSettingsChange } from "../schemas/memories.schema.ts";
import { changeSettings, listThemedMemories, runNow, settingsOf } from "../services/memories.service.ts";
import type { Handler } from "../types/http.types.ts";
import { readJson, send } from "../utils/http.ts";

export const memoriesController = {
  async settings(req, res) {
    const { user } = await requireUser(req);
    send(res, 200, settingsOf(user.id));
  },

  // Turning off, and the creations choice, work while the feature is switched off.
  async changeSettings(req, res) {
    const body = await readJson(req); // the JSON content type is also the cross-site guard
    const { user, cred } = await requireSessionUser(req);
    send(res, 200, await changeSettings(user, cred, parseSettingsChange(body)));
  },

  async labels(req, res) {
    const { user } = await requireUser(req);
    send(res, 200, { memories: listThemedMemories(user.id) });
  },

  async run(req, res) {
    const body = await readJson(req);
    const { user } = await requireSessionUser(req);
    send(res, 200, await runNow(user, parseRunOptions(body)));
  },
} satisfies Record<string, Handler>;
