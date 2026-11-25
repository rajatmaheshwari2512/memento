// What POST /ask accepts (controllers/ask.controller.ts).

import { MAX_QUESTION_CHARS } from "../constants/ask.constants.ts";
import type { AskRequest } from "../types/ask.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { isTimeZone } from "../utils/time-zone.ts";

export function parseAskRequest(body: Record<string, unknown>): AskRequest {
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) throw new HttpError(400, "Type what you're looking for.");
  if (question.length > MAX_QUESTION_CHARS) throw new HttpError(400, `Keep the question under ${MAX_QUESTION_CHARS} characters.`);
  const timeZone = body.timeZone ?? "UTC";
  if (!isTimeZone(timeZone)) throw new HttpError(400, "timeZone must be a time zone, e.g. Asia/Kolkata or +05:30.");
  const language = typeof body.language === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(body.language) ? body.language : "en";
  const cursor = body.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2000)) throw new HttpError(400, "cursor isn't valid.");
  return { question, timeZone, language, cursor: cursor as string | null };
}
