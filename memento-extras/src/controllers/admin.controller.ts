// Memento admin (the Android app's Settings → Memento admin): the switches with their labels,
// everyone's AI edits, and one person's own daily limit. Admins only, logged in.

import { requireAdmin } from "../middleware/auth.middleware.ts";
import { parseDailyLimit, parseUserId } from "../schemas/admin.schema.ts";
import { settingsList } from "../schemas/flags.schema.ts";
import { flagsAndDefaults } from "../services/flags.service.ts";
import { everyonesUsage, setOwnDailyLimit } from "../services/limits.service.ts";
import type { Handler } from "../types/http.types.ts";
import { log, readJson, send } from "../utils/http.ts";

export const adminController = {
  async settings(req, res) {
    await requireAdmin(req);
    send(res, 200, { ...flagsAndDefaults(), settings: settingsList() });
  },

  async usage(req, res) {
    await requireAdmin(req);
    send(res, 200, everyonesUsage());
  },

  async setDailyLimit(req, res, { id }) {
    const body = await readJson(req); // the JSON content type is also the cross-site guard
    const { user } = await requireAdmin(req);
    const userId = parseUserId(id!);
    const dailyEdits = parseDailyLimit(body);
    setOwnDailyLimit(userId, dailyEdits, user.id);
    log({ event: "user_limit_changed", user: user.id, for: userId, dailyEdits });
    send(res, 200, everyonesUsage());
  },
} satisfies Record<string, Handler>;
