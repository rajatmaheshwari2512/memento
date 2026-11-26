// Memento's switches, for the apps (to hide switched-off features) and for admins to change.

import { requireAdmin, requireUser } from "../middleware/auth.middleware.ts";
import { parseFlagChanges } from "../schemas/flags.schema.ts";
import { flagsAndDefaults, setFlags } from "../services/flags.service.ts";
import type { Handler } from "../types/http.types.ts";
import { log, readJson, send } from "../utils/http.ts";

export const flagsController = {
  // Any logged-in user: the apps use this to hide switched-off features.
  async get(req, res) {
    await requireUser(req);
    send(res, 200, flagsAndDefaults());
  },

  async update(req, res) {
    const body = await readJson(req);
    const { user } = await requireAdmin(req);
    const changes = setFlags(parseFlagChanges(body), user.id);
    for (const change of changes) log({ event: "flag_changed", user: user.id, ...change });
    send(res, 200, flagsAndDefaults());
  },
} satisfies Record<string, Handler>;
