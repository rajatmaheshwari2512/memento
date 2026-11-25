// Ask Photos: what code can read exactly in a phrase the trained reader (ask-reader.service.ts)
// marked: a date ("last December", "pichle saal", "Mom's birthday") turned into calendar dates,
// and names matched to the asker's People page ("Rahul's" → Rahul Sharma). The model decides
// which words are a date, a person, a thing or a place; whole questions are only scanned for
// People-page names the model missed (the reader's safety net).
// (The first version of Ask read whole questions with hand-written rules here; they were
// removed on 2026-11-21, once the trained reader did better. eval/intent/README.md says how to
// run them from git history.)
//
// Pure: no database, no Immich calls, no clock. Today's date and the people are passed in, so it
// can be tested on its own (test/ask-parser.test.ts).
//
// English, plus the Hindi time words of Hinglish dates ("pichle saal", "2 saal pehle").

import { AFTER, BEFORE, CUT, DAY, EARLIEST_YEAR, FILLER, HINDI_NUMBER, HINDI_NUMBER_WORDS, HINDI_UNIT, HINDI_UNITS, JOINERS, MAX_QUESTION_CHARS, MONTH, MONTHS, MONTH_NAMES, NUMBER, NUMBER_WORDS, POSSESSIVE, YEAR } from "../constants/ask.constants.ts";
import type { DateRange, Found, Instants, Person, PhraseReading, Plan, ReaderContext, Today } from "../types/ask.types.ts";
import { wordsOf } from "../utils/words.ts";
import { addDays, dayIn, startOfDay as dayStartMs } from "../utils/local-date.ts";


// --- calendar dates (pure arithmetic on y/m/d, no time zones) ---

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const partsOf = (date: string) => date.split("-").map(Number) as [number, number, number];


// Same day n months earlier/later, kept inside the month (31 Mar - 1 month = 28/29 Feb).
function addMonths(date: string, n: number): string {
  const [y, m, d] = partsOf(date);
  const index = y * 12 + (m - 1) + n;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  return ymd(ny, nm, Math.min(d, daysIn(ny, nm)));
}

const validDay = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
// The same day in year y; 29 Feb falls on 28 Feb in other years.
const sameDayIn = (y: number, m: number, d: number) => ymd(y, m, Math.min(d, daysIn(y, m)));
const monthRange = (y: number, m: number): DateRange => ({ from: ymd(y, m, 1), to: ymd(y, m, daysIn(y, m)) });
const yearRange = (y: number): DateRange => ({ from: ymd(y, 1, 1), to: ymd(y, 12, 31) });
const dayRange = (date: string): DateRange => ({ from: date, to: date });
const todayOf = (t: Today) => ymd(t.y, t.m, t.d);
const weekday = (date: string) => {
  const [y, m, d] = partsOf(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
};

// The latest month `m` that has started by today (this month counts).
function latestMonth(m: number, today: Today): number {
  return m <= today.m ? today.y : today.y - 1;
}

const SHORT_MONTH = (m: number) => MONTH_NAMES[m - 1]!.slice(0, 3);
function dayLabel(date: string): string {
  const [y, m, d] = partsOf(date);
  return `${d} ${SHORT_MONTH(m)} ${y}`;
}

// A readable label for one range: "2022", "December 2025", "25 Dec 2023", "2019 – 2021",
// or "1 Nov – 20 Nov 2026".
export function rangeLabel(r: DateRange): string {
  const [fy, fm, fd] = partsOf(r.from);
  const [ty, tm, td] = partsOf(r.to);
  if (r.from === r.to) return dayLabel(r.from);
  if (fm === 1 && fd === 1 && tm === 12 && td === 31) return fy === ty ? String(fy) : `${fy} – ${ty}`;
  if (fy === ty && fm === tm && fd === 1 && td === daysIn(ty, tm)) return `${MONTH_NAMES[fm - 1]} ${fy}`;
  if (fd === 1 && td === daysIn(ty, tm)) return `${SHORT_MONTH(fm)} ${fy} – ${SHORT_MONTH(tm)} ${ty}`;
  if (fy === ty) return `${fd} ${SHORT_MONTH(fm)} – ${td} ${SHORT_MONTH(tm)} ${ty}`;
  return `${dayLabel(r.from)} – ${dayLabel(r.to)}`;
}

// The same day every year, from `first` up to today (Christmas, birthdays).
function everyYear(first: number, today: Today, m: number, d: number, length = 1): DateRange[] {
  const ranges: DateRange[] = [];
  for (let y = Math.max(first, EARLIEST_YEAR); y <= today.y; y++) {
    const from = sameDayIn(y, m, d);
    if (from > todayOf(today)) break;
    ranges.push({ from, to: addDays(from, length - 1) });
  }
  return ranges;
}

// --- the question, as a string with pieces cut out ---

class Question {
  s: string;
  constructor(text: string) {
    this.s = ` ${text.replace(/\s+/g, " ").trim()} `;
  }

  // Finds `pattern` (case-insensitive) outside pieces already cut. If `use` accepts the
  // match, the match is cut out. Returns whether something was cut. With `all`, keeps going.
  take(pattern: string, use: (m: RegExpExecArray) => boolean, all = false): boolean {
    const re = new RegExp(pattern, "giu");
    let cut = false;
    let from = 0;
    for (;;) {
      re.lastIndex = from;
      const m = re.exec(this.s);
      if (!m) return cut;
      if (m[0].includes(CUT) || m[0].trim() === "" || !use(m)) {
        from = m.index + Math.max(1, m[0].length);
        continue;
      }
      this.s = `${this.s.slice(0, m.index)} ${CUT} ${this.s.slice(m.index + m[0].length)}`;
      cut = true;
      if (!all) return true;
      from = m.index;
    }
  }

  // What's left, with joiners next to cut pieces removed ("beach in June 2024" → "beach").
  leftover(): string {
    let tokens = this.s.split(/\s+/).filter(Boolean);
    for (let changed = true; changed; ) {
      changed = false;
      tokens = tokens.filter((token, i) => {
        if (!JOINERS.has(token.toLowerCase())) return true;
        const next = tokens[i + 1];
        const prev = tokens[i - 1];
        if (next === CUT || prev === CUT || next === undefined || prev === undefined) {
          changed = true;
          return false;
        }
        return true;
      });
    }
    return tokens
      .filter((t) => t !== CUT && !/^['’]s$/.test(t))
      .join(" ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/^[\s,.!?;:&+-]+|[\s,.!?;:&+-]+$/g, "")
      .trim();
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const firstWord = (s: string) => norm(s).split(" ")[0] ?? "";

// --- who is "me" ---

// 1. a face group named "me"; 2. one named like the account ("Asha Rao"); 3. one
// named the account's first name ("Asha"), if only one is. DECISIONS.md, "Ask Photos".
export function findMe(people: Person[], accountName: string): Person | null {
  const named = (n: string) => people.filter((p) => norm(p.name) === norm(n));
  const me = named("me")[0] ?? (norm(accountName) ? named(accountName)[0] : undefined);
  if (me) return me;
  const first = firstWord(accountName);
  if (!first || first === norm(accountName)) return null;
  const byFirst = named(first);
  return byFirst.length === 1 ? byFirst[0]! : null;
}

// Names a question can use: each face group's full name, and its first name when no other
// group has that first name ("Rahul" for "Rahul Sharma"). Longest first, so "Rahul Sharma"
// wins over "Rahul". Several groups with the same name: the first in Immich's order.
function nameIndex(people: Person[]): Array<{ name: string; pattern: string; person: Person }> {
  const named = people.filter((p) => norm(p.name) && norm(p.name) !== "me");
  const byFull = new Map<string, Person>();
  for (const p of named) if (!byFull.has(norm(p.name))) byFull.set(norm(p.name), p);
  const firstCount = new Map<string, number>();
  for (const p of named) firstCount.set(firstWord(p.name), (firstCount.get(firstWord(p.name)) ?? 0) + 1);
  const entries = new Map(byFull);
  for (const p of named) {
    const first = firstWord(p.name);
    if (first !== norm(p.name) && firstCount.get(first) === 1 && !byFull.has(first)) entries.set(first, p);
  }
  return [...entries]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([name, person]) => ({ name, pattern: escape(name), person }));
}

export const meHint = (accountName: string) =>
  `Ask doesn't know which face is you yet. On the People page, name your own face “me”${accountName.trim() ? ` or “${accountName.trim()}”` : ""}.`;

// --- dates ---

function readDates(q: Question, ctx: ReaderContext, isName: (word: string) => boolean): Found[] {
  const today = ctx.today;
  const t = todayOf(today);
  const found: Found[] = [];
  const add = (ranges: DateRange[], label?: string) => {
    found.push(label ? { ranges, label } : { ranges });
    return true;
  };
  const month = (s: string) => MONTHS[s.toLowerCase().replace(".", "")]!;
  const count = (s: string) => NUMBER_WORDS[s.toLowerCase()] ?? Number(s);
  const counted = (n: number) => n >= 1 && n <= 200;
  const addDay = (y: number, mo: number, d: number) => validDay(y, mo, d) && add([dayRange(ymd(y, mo, d))]);
  const ago = (unit: string, n: number): DateRange => {
    const u = unit.toLowerCase().replace(/s$/, "");
    if (u === "day") return dayRange(addDays(t, -n));
    if (u === "week") {
      const monday = addDays(t, -weekday(t) - 7 * n);
      return { from: monday, to: addDays(monday, 6) };
    }
    if (u === "month") {
      const [y, m] = partsOf(addMonths(ymd(today.y, today.m, 1), -n));
      return monthRange(y, m);
    }
    return yearRange(today.y - n);
  };
  const pastN = (unit: string, n: number): DateRange => {
    const u = unit.toLowerCase().replace(/s$/, "");
    const from = u === "day" ? addDays(t, -(n - 1)) : u === "week" ? addDays(t, -7 * n + 1) : u === "month" ? addDays(addMonths(t, -n), 1) : addDays(addMonths(t, -12 * n), 1);
    return { from, to: t };
  };

  for (let round = 0; round < 3; round++) {
    // "between 2019 and 2021", "2019-2021"
    const any = q.take(`(?:between|from)\\s+${YEAR}\\s+(?:and|to|till|until|-|–)\\s+${YEAR}|${YEAR}\\s*(?:-|–|to)\\s*${YEAR}`, (m) => {
      const a = Number(m[1] ?? m[3]);
      const b = Number(m[2] ?? m[4]);
      return add([{ from: yearRange(Math.min(a, b)).from, to: yearRange(Math.max(a, b)).to }]);
    }) ||
      // "since 2020", "after March 2021", "before 2015", "until 2018"
      q.take(`\\b(since|after|before|until|till|up\\s+to)\\s+(?:${MONTH}\\s+)?${YEAR}`, (m) => {
        const y = Number(m[3]);
        const period = m[2] ? monthRange(y, month(m[2])) : yearRange(y);
        const word = m[1]!.toLowerCase();
        if (word === "since") return add([{ from: period.from, to: t }]);
        if (word === "after") return add([{ from: addDays(period.to, 1), to: t }]);
        if (word === "before") return add([{ from: ymd(1900, 1, 1), to: addDays(period.from, -1) }]);
        return add([{ from: ymd(1900, 1, 1), to: period.to }]);
      }) ||
      // 2023-12-25
      q.take(`${YEAR}-(\\d{2})-(\\d{2})(?!\\d)`, (m) => addDay(Number(m[1]), Number(m[2]), Number(m[3]))) ||
      // 25/12/2023 (day first, as in India)
      q.take(`(?<!\\d)(\\d{1,2})[/.](\\d{1,2})[/.]${YEAR}`, (m) => addDay(Number(m[3]), Number(m[2]), Number(m[1]))) ||
      // 25 December 2023, 25th of Dec 2023, December 25, 2023
      q.take(`${DAY}\\s+(?:of\\s+)?${MONTH},?\\s+${YEAR}|\\b${MONTH}\\s+${DAY},?\\s+${YEAR}`, (m) =>
        addDay(Number(m[3] ?? m[6]), month(m[2] ?? m[4]!), Number(m[1] ?? m[5])),
      ) ||
      // Christmas (2022), New Year's Eve (2022), New Year (2023)
      q.take(`\\b(?:(last|previous|this)\\s+)?(christmas|xmas)(?:\\s+(eve|day))?(?:\\s+(?:of\\s+)?${YEAR})?|\\b${YEAR}\\s+(christmas|xmas)`, (m) => {
        // "last Christmas", "this Christmas": the latest one that has started (photos are of the past)
        const latest = m[1] ? (t >= ymd(today.y, 12, 24) ? today.y : today.y - 1) : null;
        const y = m[4] ?? m[5] ?? latest;
        if (y) return add([{ from: ymd(Number(y), 12, 24), to: ymd(Number(y), 12, 26) }], `Christmas ${y}`);
        return add(everyYear(EARLIEST_YEAR, today, 12, 24, 3), "Christmas, every year");
      }) ||
      q.take(`\\bnew\\s+year(?:['’]s|s)?(?:\\s+(eve|day))?(?:\\s+(?:of\\s+)?${YEAR})?`, (m) => {
        const eve = m[1]?.toLowerCase() === "eve";
        const y = m[2] ? Number(m[2]) : null;
        if (y !== null) {
          const from = eve ? ymd(y, 12, 31) : ymd(y - 1, 12, 31);
          return add([{ from, to: addDays(from, 1) }], eve ? `New Year's Eve ${y}` : `New Year ${y}`);
        }
        return add(everyYear(EARLIEST_YEAR - 1, today, 12, 31, 2), "New Year, every year");
      }) ||
      // December 2023, Dec of 2023
      q.take(`(?:\\b(?:in|during)\\s+)?\\b${MONTH}(?:\\s+of)?,?\\s+${YEAR}`, (m) => add([monthRange(Number(m[2]), month(m[1]!))])) ||
      // 25 December, December 25 (the latest one up to today)
      q.take(`${DAY}\\s+(?:of\\s+)?${MONTH}${AFTER}|\\b${MONTH}\\s+${DAY}(?!\\d)`, (m) => {
        const d = Number(m[1] ?? m[4]);
        const mo = month(m[2] ?? m[3]!);
        for (let y = today.y; y >= today.y - 8; y--) {
          if (validDay(y, mo, d) && ymd(y, mo, d) <= t) return add([dayRange(ymd(y, mo, d))]);
        }
        return false;
      }) ||
      // last December, this June, past March
      q.take(`\\b(last|this|past|previous)\\s+${MONTH}${AFTER}`, (m) => {
        const mo = month(m[2]!);
        const word = m[1]!.toLowerCase();
        const y = word === "this" ? today.y : mo < today.m ? today.y : today.y - 1;
        return add([monthRange(y, mo)]);
      }) ||
      // today, yesterday, the day before yesterday
      q.take(`\\b(?:the\\s+)?day\\s+before\\s+yesterday\\b`, () => add([dayRange(addDays(t, -2))])) ||
      q.take(`\\b(today|tonight|this\\s+morning|this\\s+evening|yesterday)\\b`, (m) =>
        add([dayRange(m[1]!.toLowerCase() === "yesterday" ? addDays(t, -1) : t)]),
      ) ||
      // last weekend: the Saturday and Sunday before this week. This weekend: this week's, once
      // it has started, else the one just gone (photos are of the past).
      q.take(`\\b(this|last|previous|past|is|iss|pichle|pichhle)\\s+weekend(?:['’]s)?${AFTER}`, (m) => {
        const monday = addDays(t, -weekday(t));
        const started = weekday(t) >= 5;
        const isThis = ["this", "is", "iss"].includes(m[1]!.toLowerCase());
        const saturday = isThis && started ? addDays(monday, 5) : addDays(monday, -2);
        return add([{ from: saturday, to: addDays(saturday, 1) }]);
      }) ||
      // this week, last month, last year, past year ("this year's monsoon" too)
      q.take(`\\b(this|last|previous|past)\\s+(week|month|year)(?:['’]s)?${AFTER}`, (m) => {
        const word = m[1]!.toLowerCase();
        const unit = m[2]!.toLowerCase();
        if (word === "past") return add([pastN(unit, 1)]);
        if (word !== "this") return add([ago(unit, 1)]);
        return add([{ from: unit === "week" ? addDays(t, -weekday(t)) : ymd(today.y, unit === "month" ? today.m : 1, 1), to: t }]);
      }) ||
      // last 3 months, past 10 days
      q.take(`\\b(?:last|past|previous)\\s+${NUMBER}\\s+(days?|weeks?|months?|years?)\\b`, (m) => {
        const n = count(m[1]!);
        return counted(n) && add([pastN(m[2]!, n)]);
      }) ||
      // 2 years ago, a month ago
      q.take(`\\b${NUMBER}\\s+(days?|weeks?|months?|years?)\\s+ago\\b`, (m) => {
        const n = count(m[1]!);
        return counted(n) && add([ago(m[2]!, n)]);
      }) ||
      // Hinglish, the same dates as their English forms: aaj, kal (yesterday: photos are of
      // the past), parso; pichle/is hafte, mahine, saal; pichle 3 din; 2 saal pehle.
      // A People-page name wins ("Kal and Jo at the beach"), as for month names.
      q.take(`\\b(aaj|kal|parso)${AFTER}`, (m) => {
        if (isName(m[1]!)) return false;
        const word = m[1]!.toLowerCase();
        return add([dayRange(word === "aaj" ? t : addDays(t, word === "kal" ? -1 : -2))]);
      }) ||
      q.take(`\\b(pichle|pichhle|pichla|pichhla|pichli|pichhli|is|iss)\\s+(${HINDI_UNITS})${AFTER}`, (m) => {
        if (isName(m[2]!)) return false;
        const unit = HINDI_UNIT[m[2]!.toLowerCase()]!;
        if (/^pich/i.test(m[1]!)) return add([ago(unit, 1)]);
        if (unit === "day") return add([dayRange(t)]); // "is din": today
        return add([{ from: unit === "week" ? addDays(t, -weekday(t)) : ymd(today.y, unit === "month" ? today.m : 1, 1), to: t }]);
      }) ||
      q.take(`\\b(?:pichle|pichhle)\\s+${HINDI_NUMBER}\\s+(${HINDI_UNITS})${AFTER}`, (m) => {
        const n = HINDI_NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
        return counted(n) && add([pastN(HINDI_UNIT[m[2]!.toLowerCase()]!, n)]);
      }) ||
      q.take(`\\b${HINDI_NUMBER}\\s+(${HINDI_UNITS})\\s+(?:pehle|pahle|pehele)${AFTER}`, (m) => {
        const n = HINDI_NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
        return counted(n) && add([ago(HINDI_UNIT[m[2]!.toLowerCase()]!, n)]);
      }) ||
      // the 2010s
      q.take(`\\b(?:the\\s+)?((?:19[5-9]|20[0-9])0)['’]?s\\b`, (m) => {
        const y = Number(m[1]);
        return add([{ from: yearRange(y).from, to: yearRange(y + 9).to }], `The ${y}s`);
      }) ||
      // 2022, in 2022
      q.take(`(?:\\b(?:in|during|from|of)\\s+)?${YEAR}`, (m) => add([yearRange(Number(m[1]))])) ||
      // in December, during June (the latest one that has started)
      q.take(`\\b(in|during|of)\\s+${MONTH}${AFTER}`, (m) => {
        // "photos of June": the person June, if there is one; but "end of June" is the month
        const partOf = /(?<![\p{L}\p{N}])(?:end|start|beginning|middle|mid|week|first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)\s*$/iu;
        if (m[1]!.toLowerCase() === "of" && isName(m[2]!) && !partOf.test(m.input.slice(0, m.index))) return false;
        const mo = month(m[2]!);
        return add([monthRange(latestMonth(mo, today), mo)]);
      }) ||
      // a full month name on its own, unless it's someone's name ("June") or a common word
      q.take(`\\b(january|february|april|june|july|august|september|october|november|december)${AFTER}`, (m) => {
        if (isName(m[1]!)) return false;
        const mo = month(m[1]!);
        return add([monthRange(latestMonth(mo, today), mo)]);
      });
    if (!any) break;
  }
  return found;
}

// --- reading a phrase ---

// A phrase → its dates, the People-page names in it, and the words left over (without
// filler). Birthdays first ("Mom's birthday" is her birthday, not photos of her), then the
// other dates, then names, so a name that's also a date word stays a person only where the
// date reader leaves it ("photos of June", but "in June" is the month).
export function readPhrase(phrase: string, ctx: ReaderContext): PhraseReading {
  const q = new Question(phrase.slice(0, MAX_QUESTION_CHARS));
  const hints: string[] = [];
  const people: Plan["people"] = [];
  const addPerson = (p: Person) => {
    if (!people.some((x) => x.id === p.id)) people.push({ id: p.id, name: p.name });
  };
  const me = findMe(ctx.people, ctx.accountName);
  const names = nameIndex(ctx.people);
  const byName = new Map(names.map((n) => [n.name, n.person]));
  const isName = (word: string) => byName.has(norm(word));
  const anyName = names.map((n) => n.pattern).join("|");

  // "my birthday", "Mom's birthday 2022": the person's birthday from the People page.
  const got: { birthdays: Found | null } = { birthdays: null };
  q.take(`${BEFORE}(my${anyName ? `|${anyName}` : ""})${POSSESSIVE}\\s+(?:birthday|bday|b['’]day)s?(?:\\s+(?:in\\s+|of\\s+)?${YEAR})?`, (m) => {
    const owner = m[1]!;
    const person = owner.toLowerCase() === "my" ? me : (byName.get(norm(owner)) ?? null);
    if (!person) {
      if (owner.toLowerCase() === "my") hints.push(meHint(ctx.accountName));
      return false;
    }
    if (!person.birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(person.birthDate)) {
      hints.push(`Add ${person === me ? "your" : `${person.name}'s`} birthday on the People page to search by it.`);
      return false;
    }
    const [by, bm, bd] = partsOf(person.birthDate);
    const whose = person === me ? "Your" : `${person.name}'s`;
    got.birthdays = m[2]
      ? { ranges: [dayRange(sameDayIn(Number(m[2]), bm, bd))], label: `${whose} birthday ${m[2]}` }
      : { ranges: everyYear(by, ctx.today, bm, bd), label: `${whose} birthday, every year` };
    return got.birthdays.ranges.length > 0;
  });

  const dates = readDates(q, ctx, isName);
  if (got.birthdays) dates.unshift(got.birthdays);

  // People by name (possessives too: "Mom's"). One pattern for all the names, longest first,
  // so "Rahul Sharma" wins over "Rahul".
  if (anyName) {
    q.take(`${BEFORE}(${anyName})${POSSESSIVE}${AFTER}`, (m) => {
      const person = byName.get(norm(m[1]!));
      if (person) addPerson(person);
      return person !== undefined;
    }, true);
  }

  const words = wordsOf(q.leftover()).filter((w) => !FILLER.has(w));
  const ranges = dates.flatMap((d) => d.ranges);
  return {
    people,
    dates: ranges.length === 0 ? null : { ranges, label: dates.map((d) => d.label ?? d.ranges.map(rangeLabel).join(", ")).join(" or ") },
    words,
    hints,
  };
}

// A phrase the model marked as a date. A lone month name is the month ("June" → in June):
// readPhrase alone would leave it to a person named June, or to the word "may".
const MONTH_ONLY = new RegExp(`^(${MONTH_NAMES.join("|")})$`, "i");
export function readDate(phrase: string, ctx: ReaderContext): PhraseReading {
  return readPhrase(MONTH_ONLY.test(phrase.trim()) ? `in ${phrase.trim()}` : phrase, ctx);
}

// --- time zones: the user's calendar days as instants, for Immich's filter ---

// The instant a calendar day starts in `tz` (utils/local-date.ts), as Immich's filter takes it.
export function startOfDay(date: string, tz: string): string {
  return new Date(dayStartMs(date, tz)).toISOString();
}

// [start of `from`, start of the day after `to`) as instants.
export function rangeInstants(r: DateRange, tz: string): Instants {
  return { gte: startOfDay(r.from, tz), lt: startOfDay(addDays(r.to, 1), tz) };
}

export function todayIn(tz: string, now = new Date()): Today {
  const [y, m, d] = partsOf(dayIn(now, tz));
  return { y, m, d };
}
