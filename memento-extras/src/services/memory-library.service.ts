// What themed memories know about a person's library, read from Immich with their key each night: the timeline (month by month), the photo search (with EXIF and people), and people. Only the user's own photos; a stack counts as its top photo.

import { listPeople, searchAll, timelineMonth, timelineMonths } from "../clients/immich.client.ts";
import { BIG_DAY, LIMITS, SPOTLIGHT } from "../constants/memories.constants.ts";
import type { AssetJson, Credential, TimelineMonth } from "../types/immich.types.ts";
import type { Candidate, LibraryItem, SpotlightPerson } from "../types/memories.types.ts";
import { addDays, monthOf, monthsBetween, startOfDay } from "../utils/local-date.ts";
import { countsByDay } from "./memory-themes.service.ts";

const HOUR = 3_600_000;

// Immich sends the timeline's times without a zone; they're UTC.
function utc(value: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
}

export function itemsOf(m: TimelineMonth, userId: string): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (let i = 0; i < m.id.length; i++) {
    if (m.ownerId[i] !== userId) continue;
    const takenAt = utc(m.fileCreatedAt[i]!);
    const local = new Date(takenAt + (m.localOffsetHours[i] ?? 0) * HOUR);
    items.push({
      id: m.id[i]!, takenAt, day: local.toISOString().slice(0, 10), isImage: m.isImage[i] ?? true, isFavorite: m.isFavorite[i] ?? false,
      lat: m.latitude?.[i] ?? null, lon: m.longitude?.[i] ?? null, city: m.city?.[i] ?? null,
    });
  }
  return items;
}

// The past ~13 months, and the list of every month with its count.
export async function loadRecent(cred: Credential, userId: string, today: string) {
  const months = await timelineMonths(cred);
  const since = monthOf(addDays(today, -400));
  const items: LibraryItem[] = [];
  for (const { month } of months) {
    if (month >= since && month <= monthOf(today)) items.push(...itemsOf(await timelineMonth(cred, month), userId));
  }
  return { items, months };
}

// Photos per day over the whole library; only months with enough photos for a big day are read (at most LIMITS.olderMonths, newest first).
export async function loadAllCounts(
  cred: Credential, userId: string, months: Array<{ month: string; count: number }>, recent: LibraryItem[], today: string,
): Promise<Map<string, number>> {
  const counts = countsByDay(recent);
  const since = monthOf(addDays(today, -400));
  const busy = months.filter(({ month, count }) => month < since && count >= BIG_DAY.minItems)
    .sort((a, b) => b.month.localeCompare(a.month)).slice(0, LIMITS.olderMonths);
  for (const { month } of busy) {
    for (const [day, n] of countsByDay(itemsOf(await timelineMonth(cred, month), userId))) counts.set(day, n);
  }
  return counts;
}

// Named people with enough photos to be worth a Spotlight, and how many each has. Hidden people aren't listed.
export async function loadSpotlightPeople(cred: Credential): Promise<SpotlightPerson[]> {
  const people = (await listPeople(cred)).filter((p) => p.name.trim() !== "").slice(0, LIMITS.spotlightPeople);
  const out: SpotlightPerson[] = [];
  for (const p of people) {
    const months = await timelineMonths(cred, p.id);
    const photos = months.reduce((n, m) => n + m.count, 0);
    if (photos >= SPOTLIGHT.minPhotos) out.push({ id: p.id, name: p.name.trim(), birthDate: p.birthDate, photos });
  }
  return out;
}

type SearchedAsset = AssetJson & {
  ownerId?: string; type?: string; isFavorite?: boolean; localDateTime?: string; duration?: number | null;
  originalFileName?: string; originalMimeType?: string; duplicateId?: string | null; width?: number | null; height?: number | null;
  exifInfo?: {
    make?: string | null; model?: string | null; rating?: number | null; exifImageWidth?: number | null; exifImageHeight?: number | null;
    latitude?: number | null; longitude?: number | null; city?: string | null; state?: string | null; country?: string | null;
  };
  people?: Array<{ id: string; name?: string; isHidden?: boolean }>;
};

// Immich's photo JSON → what a memory's photos are chosen by. null for someone else's photo.
export function toCandidate(json: AssetJson, userId: string): Candidate | null {
  const a = json as SearchedAsset;
  if (a.ownerId !== userId) return null;
  const exif = a.exifInfo ?? {};
  const w = exif.exifImageWidth ?? a.width ?? null;
  const h = exif.exifImageHeight ?? a.height ?? null;
  const localDateTime = a.localDateTime ?? a.fileCreatedAt;
  return {
    id: a.id,
    isImage: a.type !== "VIDEO",
    takenAt: Date.parse(a.fileCreatedAt),
    localDateTime,
    day: localDateTime.slice(0, 10),
    isFavorite: a.isFavorite === true,
    rating: exif.rating ?? null,
    durationMs: typeof a.duration === "number" ? a.duration : null,
    fileName: a.originalFileName ?? "",
    mime: a.originalMimeType ?? null,
    hasCamera: Boolean(exif.make?.trim() || exif.model?.trim()),
    megapixels: w && h ? (w * h) / 1e6 : null,
    shape: a.width && a.height ? `${a.width}x${a.height}` : null,
    duplicateId: a.duplicateId ?? null,
    people: (a.people ?? []).map((p) => ({ id: p.id, named: (p.name ?? "").trim() !== "" })),
    hiddenPerson: (a.people ?? []).some((p) => p.isHidden === true),
    lat: exif.latitude ?? null,
    lon: exif.longitude ?? null,
    city: exif.city ?? null,
    state: exif.state ?? null,
    country: exif.country ?? null,
    stacked: false,
  };
}

// What the person's timeline shows in these months, optionally only one person's.
async function shownIn(cred: Credential, userId: string, months: string[], personId?: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const month of months.slice(-LIMITS.olderMonths)) {
    for (const item of itemsOf(await timelineMonth(cred, month, personId), userId)) ids.add(item.id);
  }
  return ids;
}

// Every photo and video taken on these local days that the timeline shows, and the photos stacked under them.
export async function candidatesForDays(cred: Credential, userId: string, first: string, last: string, timeZone: string): Promise<Candidate[]> {
  const shown = await shownIn(cred, userId, monthsBetween(first, last));
  const from = new Date(startOfDay(first, timeZone) - 14 * HOUR).toISOString();
  const to = new Date(startOfDay(addDays(last, 1), timeZone) + 14 * HOUR).toISOString();
  return searchAll(cred, {
    filter: { takenAt: { gte: from, lt: to }, visibility: { in: ["timeline"] } },
    withExif: true, withPeople: true, orderBy: { field: "fileCreatedAt", direction: "asc" },
  }, LIMITS.searchPages, (a) => {
    const c = toCandidate(a, userId);
    return c && c.day >= first && c.day <= last ? { ...c, stacked: !shown.has(a.id) } : null;
  });
}

// Every photo and video of one person that the timeline shows.
export async function candidatesForPerson(cred: Credential, userId: string, personId: string): Promise<Candidate[]> {
  const months = (await timelineMonths(cred, personId)).map((m) => m.month).sort();
  const shown = await shownIn(cred, userId, months, personId);
  return searchAll(cred, {
    filter: { personIds: { any: [personId] }, visibility: { in: ["timeline"] } },
    withExif: true, withPeople: true, orderBy: { field: "fileCreatedAt", direction: "asc" },
  }, LIMITS.searchPages, (a) => (shown.has(a.id) ? toCandidate(a, userId) : null));
}
