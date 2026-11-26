// Backup quality: the person's own choice for backups from Memento's phone app.

import { requireUser } from "../middleware/auth.middleware.ts";
import { parseBackupSettings } from "../schemas/backup.schema.ts";
import { changeSettings, settingsOf } from "../services/backup.service.ts";
import type { Handler } from "../types/http.types.ts";
import { readJson, send } from "../utils/http.ts";

export const backupController = {
  async settings(req, res) {
    const { user } = await requireUser(req);
    send(res, 200, settingsOf(user.id));
  },

  // Choosing original works while Storage saver is switched off.
  async changeSettings(req, res) {
    const body = await readJson(req);
    const { user } = await requireUser(req);
    send(res, 200, changeSettings(user.id, parseBackupSettings(body)));
  },
} satisfies Record<string, Handler>;
