// What Memento admin's routes accept (controllers/admin.controller.ts).

import { validSetting } from "./flags.schema.ts";
import { HttpError, isUuid } from "../utils/http-error.ts";

export function parseUserId(id: string): string {
  if (!isUuid(id)) throw new HttpError(400, "That isn't a person's ID.");
  return id;
}

// { dailyEdits: n } in the daily limit flag's range, or null for everyone's default.
export function parseDailyLimit(body: Record<string, unknown>): number | null {
  const value = body.dailyEdits;
  if (value !== null && !validSetting("gemini.dailyLimitPerUser", value)) {
    throw new HttpError(400, "dailyEdits must be a whole number in the daily limit's range, or null for everyone's default.");
  }
  return value as number | null;
}
