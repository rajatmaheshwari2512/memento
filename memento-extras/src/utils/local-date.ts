// Calendar days ("2026-11-21") in a time zone, and the arithmetic themed memories need.
// Days are plain strings, so they compare and sort as text.

const DAY_MS = 86_400_000;

// The calendar day an instant falls on in `timeZone`, e.g. "2026-11-21".
export function dayIn(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Minutes past midnight in `timeZone`.
export function minutesIn(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  return Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
}

function utcMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, n: number): string {
  return new Date(utcMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

// Whole days from a to b (b later is positive).
export function daysBetween(a: string, b: string): number {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

// The instant local midnight starts `day` in `timeZone` (for searches by time taken).
export function startOfDay(day: string, timeZone: string): number {
  const guess = utcMs(day);
  const offset = (at: number) => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(p.find((x) => x.type === type)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

// "2026-10" for any day in October 2026.
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function firstOfMonth(month: string): string {
  return `${month}-01`;
}

export function lastOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Every month from `first`'s to `last`'s, e.g. ["2026-10", "2026-11"].
export function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  for (let m = monthOf(first); m <= monthOf(last); m = monthOf(addDays(lastOfMonth(m), 1))) months.push(m);
  return months;
}

// The month before `day`'s month, e.g. "2026-10" for 2026-11-01.
export function previousMonth(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

// How far apart two days' dates are within a year, ignoring the year (0–183): the distance
// to an anniversary. 29 February counts as 28 February.
export function daysFromAnniversary(day: string, other: string): number {
  const inCommonYear = (d: string) => utcMs(`2001-${d.slice(5) === "02-29" ? "02-28" : d.slice(5)}`);
  const diff = Math.abs(inCommonYear(day) - inCommonYear(other)) / DAY_MS;
  return Math.round(Math.min(diff, 365 - diff));
}

// "12 October 2023", "October".
const formatters = new Map<string, Intl.DateTimeFormat>();
function format(day: string, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
    formatters.set(key, f);
  }
  return f.format(new Date(utcMs(day)));
}

export function longDate(day: string): string {
  return format(day, { day: "numeric", month: "long", year: "numeric" });
}

export function monthName(month: string): string {
  return format(firstOfMonth(month), { month: "long" });
}
