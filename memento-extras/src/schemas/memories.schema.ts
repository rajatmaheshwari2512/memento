// What PUT /memories/settings and POST /memories/run may contain (services/memories.service.ts).

import type { RunOptions, SettingsChange } from "../types/memories.types.ts";
import { HttpError } from "../utils/http-error.ts";

// { enabled?: boolean, creations?: boolean }, at least one, nothing else.
export function parseSettingsChange(body: Record<string, unknown>): SettingsChange {
  const change: SettingsChange = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "enabled" && key !== "creations") throw new HttpError(400, `Unknown setting: ${key}.`);
    if (typeof value !== "boolean") throw new HttpError(400, `${key} must be true or false.`);
    change[key] = value;
  }
  if (Object.keys(change).length === 0) throw new HttpError(400, "Say what to change: enabled, creations or both.");
  return change;
}

// { creations?: boolean }: also queue this week's creations now.
export function parseRunOptions(body: Record<string, unknown>): RunOptions {
  for (const key of Object.keys(body)) if (key !== "creations") throw new HttpError(400, `Unknown option: ${key}.`);
  if (body.creations !== undefined && typeof body.creations !== "boolean") throw new HttpError(400, "creations must be true or false.");
  return { creations: body.creations === true };
}
