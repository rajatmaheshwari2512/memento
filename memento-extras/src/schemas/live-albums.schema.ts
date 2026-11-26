// What live albums' requests accept (controllers/live-albums.controller.ts).

import { MAX_PEOPLE } from "../constants/live-albums.constants.ts";
import type { NewLiveAlbum, Rules } from "../types/live-albums.types.ts";
import { HttpError, isUuid } from "../utils/http-error.ts";

function peopleList(value: unknown, field: string, min: number): string[] {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value) || value.some((v) => !isUuid(v))) throw new HttpError(400, `${field} must be a list of people.`);
  const ids = [...new Set(value as string[])];
  if (ids.length < min) throw new HttpError(400, "Choose at least one person.");
  if (ids.length > MAX_PEOPLE) throw new HttpError(400, `Choose at most ${MAX_PEOPLE} people.`);
  return ids;
}

// A live album's rules from a request, checked for shape.
export function parseRules(body: Record<string, unknown>): Rules {
  const include = peopleList(body.include, "include", 1);
  const exclude = peopleList(body.exclude, "exclude", 0);
  if (include.some((p) => exclude.includes(p))) throw new HttpError(400, "Someone can't be both included and excluded.");
  const match = body.match === "all" ? "all" : body.match === "any" || body.match === undefined ? "any" : null;
  if (!match) throw new HttpError(400, 'match must be "any" or "all".');
  const since = body.since === undefined || body.since === null || body.since === "" ? null : body.since;
  if (since !== null && (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since)))) {
    throw new HttpError(400, "since must be a date like 2024-01-31.");
  }
  return { include, exclude, match, since };
}

// { albumId } (an album of the user's) or { albumName } (a new one), plus the rules.
export function parseNewLiveAlbum(body: Record<string, unknown>): NewLiveAlbum {
  const rules = parseRules(body);
  if (body.albumId !== undefined) {
    if (!isUuid(body.albumId)) throw new HttpError(400, "albumId must be an album.");
    return { album: { albumId: body.albumId }, rules };
  }
  const name = typeof body.albumName === "string" ? body.albumName.trim() : "";
  if (!name || name.length > 200) throw new HttpError(400, "Give the album a name (up to 200 characters).");
  return { album: { albumName: name }, rules };
}
