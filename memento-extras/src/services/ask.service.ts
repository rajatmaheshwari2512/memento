// Ask Photos: a question in plain English → matching photos. The trained reader picks out people, dates, places, videos and favourites; Immich's search and the captions are searched for the rest, and the two lists are merged. Nothing is sent outside our servers, and the question isn't logged.

import { listPeople, searchMetadata, searchSmart } from "../clients/immich.client.ts";
import { ASK_OFF, CAPTION_RESULTS, DATED_CAPTIONS, DATE_SORTED_SMART, IDS_PER_SEARCH, PAGE, PEOPLE_CACHE_MS, RRF_K, SMART_RESULTS } from "../constants/ask.constants.ts";
import { rangeInstants, todayIn } from "./ask-parser.service.ts";
import { cachedPlaces, findPlace, placesOf, withoutOnce } from "./ask-places.service.ts";
import { wordsOf } from "../utils/words.ts";
import { readWithModel } from "./ask-reader.service.ts";
import { getFlags } from "./flags.service.ts";
import { searchCaptionIds } from "./repositories/captions.repository.ts";
import type { AskRequest, AskResult, Filter, Instants, Person, Plan } from "../types/ask.types.ts";
import type { AssetJson, Credential, User } from "../types/immich.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { log } from "../utils/http.ts";

// The user's people, cached for a minute.
const peopleCache = new Map<string, { people: Person[]; expires: number }>();

async function peopleOf(cred: Credential, userId: string): Promise<Person[]> {
  const hit = peopleCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.people;
  const people = await listPeople(cred);
  if (peopleCache.size > 100) peopleCache.clear();
  peopleCache.set(userId, { people, expires: Date.now() + PEOPLE_CACHE_MS });
  return people;
}

// The plan's people, kinds and favourites as Immich's v3 `filter`.
function filterOf(plan: Plan): Filter {
  const filter: Filter = { visibility: { eq: "timeline" }, trashedAt: { eq: null } };
  if (plan.people.length > 0) filter.personIds = { all: plan.people.map((p) => p.id) };
  if (plan.type) filter.type = { eq: plan.type };
  if (plan.favorite) filter.isFavorite = { eq: true };
  return filter;
}

function withDates(filter: Filter, ranges: Instants[]): Filter {
  if (ranges.length === 1) return { ...filter, takenAt: ranges[0] };
  if (ranges.length > 1) return { ...filter, or: ranges.map((takenAt) => ({ takenAt })) };
  return filter;
}

// Sorting by date taken, here (compare) and in Immich's search (orderBy).
function dateOrder(order: "newest" | "oldest") {
  const sign = order === "newest" ? -1 : 1;
  return {
    compare: (a: AssetJson, b: AssetJson) => sign * a.fileCreatedAt.localeCompare(b.fileCreatedAt),
    orderBy: { field: "fileCreatedAt", direction: order === "newest" ? "desc" : "asc" } as const,
  };
}

// Caption matches, through Immich with the plan's other filters. Best word match first, or with `order`, by date.
async function captionMatches(
  cred: Credential, userId: string, words: string[], filter: Filter, ranges: Instants[], order: Plan["order"],
): Promise<AssetJson[]> {
  if (words.length === 0) return [];
  const ids = searchCaptionIds(userId, words.join(" "), order ? DATED_CAPTIONS : CAPTION_RESULTS);
  if (ids.length === 0) return [];
  const local = ranges.length > 1 ? ranges : [];
  const dated = ranges.length === 1 ? withDates(filter, ranges) : filter;
  const inRange = (a: AssetJson) => local.length === 0 || local.some((r) => a.fileCreatedAt >= r.gte && a.fileCreatedAt < r.lt);
  const search = (batch: string[], extra: object) =>
    searchMetadata(cred, { filter: { ...dated, or: batch.map((id) => ({ id: { eq: id } })) }, withExif: true, size: 1000, ...extra });

  if (!order) {
    const rank = new Map(ids.map((id, i) => [id, i]));
    return (await search(ids, {})).items.filter(inRange).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  }
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_SEARCH) batches.push(ids.slice(i, i + IDS_PER_SEARCH));
  const { compare, orderBy } = dateOrder(order);
  const pages = await Promise.all(batches.map((batch) => search(batch, { orderBy, size: local.length > 0 ? 1000 : SMART_RESULTS })));
  return pages.flatMap((p) => p.items).filter(inRange).sort(compare).slice(0, SMART_RESULTS);
}

// Asked for the latest or earliest ("the last time I was at the beach"): the confident matches come first, sorted by date, then the rest, best match first.
function byDate(order: "newest" | "oldest", merged: AssetJson[], smart: AssetJson[], captions: AssetJson[]): AssetJson[] {
  const confident = new Set((captions.length > 0 ? captions : smart.slice(0, DATE_SORTED_SMART)).map((a) => a.id));
  const sorted = merged.filter((a) => confident.has(a.id)).sort(dateOrder(order).compare);
  return [...sorted, ...merged.filter((a) => !confident.has(a.id))];
}

export function fuse(lists: AssetJson[][]): AssetJson[] {
  const scores = new Map<string, { asset: AssetJson; score: number; first: number }>();
  lists.forEach((list, which) => {
    list.forEach((asset, place) => {
      const entry = scores.get(asset.id) ?? { asset, score: 0, first: which * 1e6 + place };
      entry.score += 1 / (RRF_K + place + 1);
      scores.set(asset.id, entry);
    });
  });
  return [...scores.values()].sort((a, b) => b.score - a.score || a.first - b.first).map((e) => e.asset);
}

export function requireAskPhotos(): void {
  if (!getFlags().askPhotos.enabled) throw new HttpError(403, ASK_OFF);
}

// One search: `text` for the search model, `words` for the captions, `filter` with the dates and `base` without them.
type Search = { text: string; words: string[]; filter: Filter; base: Filter; ranges: Instants[]; order: Plan["order"]; language: string };
type Ranked = { assets: AssetJson[]; counts: { smart?: number; captions?: number } };

// Ranked by the search model and the captions. One page.
async function ranked(cred: Credential, userId: string, s: Search): Promise<Ranked> {
  const [smart, captions] = await Promise.all([
    searchSmart(cred, { query: s.text, language: s.language, filter: s.filter, size: SMART_RESULTS }),
    captionMatches(cred, userId, s.words, s.base, s.ranges, s.order),
  ]);
  const merged = fuse([smart, captions]);
  return { assets: s.order ? byDate(s.order, merged, smart, captions) : merged, counts: { smart: smart.length, captions: captions.length } };
}

// Without the trained reader: the question as it is, for Immich's search model alone.
const asItIs = (question: string, readerOn: boolean): Plan => ({
  text: question.trim(), words: [], people: [], dates: null, type: null, favorite: false, order: null, places: [],
  hints: readerOn ? ["Searched as typed: reading the question (people, dates, places) isn't available right now."] : [],
});

// One page of matching photos by date: newest first, or oldest first when asked.
async function byDateOnly(cred: Credential, plan: Plan, filter: Filter): Promise<AssetJson[]> {
  const orderBy = dateOrder(plan.order ?? "newest").orderBy;
  return (await searchMetadata(cred, { filter, size: PAGE, withExif: true, orderBy })).items;
}

export async function ask(user: User, cred: Credential, { question, timeZone, language, cursor }: AskRequest): Promise<AskResult> {
  const started = Date.now();
  const places = getFlags().askPhotos.places ? placesOf(cred, user.id) : null;

  const ctx = { people: await peopleOf(cred, user.id), accountName: user.name, today: todayIn(timeZone) };
  // The trained reader when it's switched on and answers in time.
  const readerOn = getFlags().askPhotos.trainedReader;
  const fromModel = readerOn ? await readWithModel(question, ctx) : null;
  if (!fromModel && cursor) throw new HttpError(409, "These results have changed. Search again.");
  const plan = fromModel ?? asItIs(question, readerOn);
  const ranges = (plan.dates?.ranges ?? []).map((r) => rangeInstants(r, timeZone));
  const base = filterOf(plan);
  const filter = withDates(base, ranges);

  // A place in the asker's own photos ("in goa").
  const index = places ? ((await places) ?? cachedPlaces(user.id)) : null;
  const match = index && plan.places.length > 0 ? await findPlace(cred, plan, index) : null;
  const words = match ? withoutOnce(plan.words, match.words) : plan.words;
  const search: Search = { text: plan.text, words, filter, base, ranges, order: plan.order, language };
  let assets: AssetJson[];
  let nextCursor: string | null = null;
  let counts: Record<string, number | undefined>;
  if (match) {
    // Taken there first: searched for what else was asked, or with nothing else, by date.
    const at = { [match.place.kind]: { eq: match.place.name } };
    const rest = withoutOnce(wordsOf(plan.text), match.words).join(" ");
    const thereFilter = { ...filter, ...at };
    const [there, elsewhere] = await Promise.all([
      rest
        ? ranked(cred, user.id, { ...search, text: rest, filter: thereFilter, base: { ...base, ...at } })
        : byDateOnly(cred, plan, thereFilter).then((found): Ranked => ({ assets: found, counts: {} })),
      search.text ? ranked(cred, user.id, search) : Promise.resolve<Ranked>({ assets: [], counts: {} }),
    ]);
    const seen = new Set(there.assets.map((a) => a.id));
    assets = [...there.assets, ...elsewhere.assets.filter((a) => !seen.has(a.id))];
    counts = { place: there.assets.length, placeSmart: there.counts.smart, placeCaptions: there.counts.captions, ...elsewhere.counts };
  } else if (plan.text) {
    ({ assets, counts } = await ranked(cred, user.id, search));
  } else {
    // Only people, dates or kinds: every matching photo, newest first (oldest first when
    // asked), page by page.
    const orderBy = plan.order ? { orderBy: dateOrder(plan.order).orderBy } : {};
    const page = await searchMetadata(cred, { filter, size: PAGE, withExif: true, ...orderBy, ...(cursor ? { cursor } : {}) });
    assets = page.items;
    nextCursor = page.nextCursor;
    counts = { byDate: page.items.length };
  }

  log({
    event: "ask", user: user.id, reader: fromModel ? "model" : readerOn ? "down" : "off", ms: Date.now() - started, people: plan.people.length, dates: plan.dates?.ranges.length ?? 0,
    type: plan.type, favorite: plan.favorite, order: plan.order, place: match?.place.kind ?? null, words: words.length, hints: plan.hints.length,
    ...counts, results: assets.length,
  });
  const { words: _words, places: _places, ...understood } = plan;
  return { understood: { ...understood, place: match?.place ?? null }, assets, nextCursor };
}
