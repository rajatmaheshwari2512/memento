// What code reads in a phrase the trained reader marked (src/services/ask-parser.service.ts,
// readPhrase): dates, People-page names, birthdays, the words left over, and time zones.
// "Today" is fixed at Friday 20 Nov 2026. Run: npm test

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findMe, rangeInstants, readPhrase, startOfDay, todayIn } from "../src/services/ask-parser.service.ts";
import type { Person } from "../src/types/ask.types.ts";
import { isTimeZone } from "../src/utils/time-zone.ts";

const person = (id: string, name: string, birthDate: string | null = null): Person => ({ id, name, birthDate });
const PEOPLE = [
  person("mom", "Mom", "1965-03-14"),
  person("me-full", "Asha Rao"),
  person("rahul", "Rahul Sharma"),
  person("dad", "Dad"),
  person("dad-2", "Dad"), // a second face group with the same name: the first one is used
  person("june", "June"),
  person("leap", "Leap Kid", "2000-02-29"),
];
const TODAY = { y: 2026, m: 11, d: 20 };
const read = (q: string, people = PEOPLE, accountName = "Asha Rao") => readPhrase(q, { people, accountName, today: TODAY });
const names = (q: string, people = PEOPLE, accountName = "Asha Rao") => read(q, people, accountName).people.map((p) => p.id);
const range = (q: string, people = PEOPLE) => {
  const d = read(q, people).dates;
  return d && d.ranges.length === 1 ? `${d.ranges[0]!.from}..${d.ranges[0]!.to}` : d;
};

describe("people", () => {
  test("a person named like a common word is still a person", () => {
    const will = [person("will", "Will")];
    assert.deepEqual(names("Will find the cat", will), ["will"]);
    assert.deepEqual(names("will you show me Will at the beach", will), ["will"]);
  });

  test("a person named like a month: 'of June' is the person", () => {
    const june = read("latest photos of June");
    assert.deepEqual([june.people.map((p) => p.id), june.dates], [["june"], null]);
    assert.deepEqual(names("best photos of June"), ["june"]);
    assert.equal(range("beach in June"), "2026-06-01..2026-06-30"); // "in June" is still the month
    assert.equal(range("photos of June", [person("mom", "Mom")]), "2026-06-01..2026-06-30"); // no one called June
    // part of the month: the month, even with June on the People page
    for (const q of ["end of June", "first week of June", "the first of June", "middle of June"]) {
      assert.deepEqual([names(q), range(q)], [[], "2026-06-01..2026-06-30"], q);
    }
    assert.deepEqual(names("my friend of June's"), ["june"]); // "friend" isn't "end"
  });

  test("me: a face group named 'me', else the account name, else the first name if only one", () => {
    assert.equal(findMe(PEOPLE, "Asha Rao")?.id, "me-full");
    assert.equal(findMe([...PEOPLE, person("me-face", "Me")], "Asha Rao")?.id, "me-face");
    assert.equal(findMe([person("asha", "Asha")], "Asha Rao")?.id, "asha");
    assert.equal(findMe([person("a1", "Asha"), person("a2", "Asha")], "Asha Rao"), null); // two "Asha": unclear
    assert.equal(findMe([person("x", "Rao")], "Asha Rao"), null);
  });

  test("longest name first, first names when unique, possessives, duplicates", () => {
    const people = [person("r1", "Rahul"), person("r2", "Rahul Sharma"), person("p", "Priya Shah")];
    assert.deepEqual(names("Rahul Sharma at the beach", people), ["r2"]);
    assert.deepEqual(names("Rahul at the beach", people), ["r1"]);
    assert.deepEqual(names("Priya's wedding", people), ["p"]); // first name, possessive
    assert.deepEqual(names("Priya", [...people, person("p2", "Priya Nair")]), []); // two Priyas: unclear
    assert.deepEqual(names("Dad"), ["dad"]);
    assert.deepEqual(names("rahul"), ["rahul"]);
    assert.deepEqual(names("Mom and Dad"), ["mom", "dad"]);
  });

  test("a month that's also someone's name stays a person", () => {
    assert.deepEqual(names("June at the park"), ["june"]);
    assert.equal(read("June at the park").dates, null);
    assert.equal(range("kids playing in june"), "2026-06-01..2026-06-30"); // "in": the month
  });
});

describe("dates", () => {
  test("months", () => {
    assert.equal(range("last December"), "2025-12-01..2025-12-31");
    assert.equal(range("in December"), "2025-12-01..2025-12-31");
    assert.equal(range("this December"), "2026-12-01..2026-12-31");
    assert.equal(range("last October"), "2026-10-01..2026-10-31");
    assert.equal(range("last November"), "2025-11-01..2025-11-30"); // not this month
    assert.equal(range("in November"), "2026-11-01..2026-11-30");
    assert.equal(range("December 2023"), "2023-12-01..2023-12-31");
    assert.equal(range("in may 2024"), "2024-05-01..2024-05-31");
    assert.equal(read("may i see goa").dates, null); // "may" alone isn't a month
  });

  test("years and spans", () => {
    assert.equal(range("2019"), "2019-01-01..2019-12-31");
    assert.equal(range("between 2019 and 2021"), "2019-01-01..2021-12-31");
    assert.equal(range("2021-2019"), "2019-01-01..2021-12-31");
    assert.equal(range("since 2020"), "2020-01-01..2026-11-20");
    assert.equal(range("after March 2021"), "2021-04-01..2026-11-20");
    assert.equal(range("before 2015"), "1900-01-01..2014-12-31");
    assert.equal(range("the 2010s"), "2010-01-01..2019-12-31");
    assert.equal(read("2019 or 2021").dates?.label, "2019 or 2021");
  });

  test("days", () => {
    for (const q of ["25 Dec 2023", "25th of December 2023", "December 25, 2023", "25/12/2023", "2023-12-25"]) {
      assert.equal(range(q), "2023-12-25..2023-12-25", q);
    }
    assert.equal(range("December 25"), "2025-12-25..2025-12-25"); // the latest one
    assert.equal(range("5 Nov"), "2026-11-05..2026-11-05");
    assert.equal(range("31 Feb 2023"), "2023-02-01..2023-02-28"); // no such day: the month
    assert.equal(range("yesterday"), "2026-11-19..2026-11-19");
    assert.equal(range("today"), "2026-11-20..2026-11-20");
  });

  test("relative", () => {
    assert.equal(range("last week"), "2026-11-09..2026-11-15"); // Monday to Sunday
    assert.equal(range("this week"), "2026-11-16..2026-11-20");
    assert.equal(range("last month"), "2026-10-01..2026-10-31");
    assert.equal(range("this year"), "2026-01-01..2026-11-20");
    assert.equal(range("last year"), "2025-01-01..2025-12-31");
    assert.equal(range("3 months ago"), "2026-08-01..2026-08-31");
    assert.equal(range("a year ago"), "2025-01-01..2025-12-31");
    assert.equal(range("last 3 months"), "2026-08-21..2026-11-20");
    assert.equal(range("past 10 days"), "2026-11-11..2026-11-20");
  });

  test("Christmas and birthdays, one year or every year", () => {
    assert.equal(range("christmas 2022"), "2022-12-24..2022-12-26");
    const every = read("Christmas").dates!;
    assert.equal(every.label, "Christmas, every year");
    assert.deepEqual(every.ranges.at(-1), { from: "2025-12-24", to: "2025-12-26" }); // 2026's hasn't come yet
    const mom = read("Mom's birthday").dates!;
    assert.equal(mom.label, "Mom's birthday, every year");
    assert.deepEqual(mom.ranges[0], { from: "1990-03-14", to: "1990-03-14" });
    assert.deepEqual(mom.ranges.at(-1), { from: "2026-03-14", to: "2026-03-14" });
    assert.deepEqual(read("Mom's birthday").people, []); // her birthday, not photos of her
    assert.equal(range("Mom's birthday 2022"), "2022-03-14..2022-03-14");
    assert.equal(range("Leap Kid's birthday 2023"), "2023-02-28..2023-02-28");
  });

  test("a birthday nobody entered: a hint, and the word stays", () => {
    const plan = read("my birthday");
    assert.equal(plan.dates, null);
    assert.deepEqual(plan.words, ["birthday"]);
    assert.match(plan.hints[0]!, /Add your birthday on the People page/);
    const dad = read("Dad's birthday");
    assert.deepEqual(dad.people.map((p) => p.id), ["dad"]);
    assert.match(dad.hints[0]!, /Add Dad's birthday/);
  });

  test("last Christmas, last weekend, this weekend", () => {
    assert.equal(read("last Christmas").dates?.label, "Christmas 2025");
    assert.equal(range("last weekend"), "2026-11-14..2026-11-15"); // today is Friday 20 Nov 2026
    // on a weekday, "this weekend" is the one just gone: photos are of the past
    assert.equal(range("this weekend"), "2026-11-14..2026-11-15");
    assert.equal(range("when we met last week"), "2026-11-09..2026-11-15");
  });

  test("what's left of a date phrase: the words code can't turn into dates", () => {
    assert.deepEqual(read("last Christmas").words, []);
    assert.deepEqual(read("this year's monsoon").words, ["monsoon"]);
    assert.deepEqual(read("diwali 2023").words, ["diwali"]);
    const wedding = read("Rahul's wedding in March 2023");
    assert.deepEqual([wedding.words, names("Rahul's wedding in March 2023"), range("Rahul's wedding in March 2023")], [["wedding"], ["rahul"], "2023-03-01..2023-03-31"]);
    assert.deepEqual(read("pichle saal ki").words, []); // grammar words aren't searched
  });
});

describe("Hinglish dates (the same dates as their English forms)", () => {
  test("aaj, kal, parso; pichle/is hafte, mahine, saal; pichle 3 din; 2 saal pehle; pichle weekend", () => {
    assert.equal(range("aaj ki pics"), "2026-11-20..2026-11-20");
    assert.equal(range("kal wale snaps"), "2026-11-19..2026-11-19"); // yesterday: photos are of the past
    assert.equal(range("parso"), "2026-11-18..2026-11-18");
    assert.equal(range("pichle saal goa"), "2025-01-01..2025-12-31");
    assert.equal(range("pichle mahine"), "2026-10-01..2026-10-31");
    assert.equal(range("is saal"), "2026-01-01..2026-11-20");
    assert.equal(range("pichle 3 din"), "2026-11-18..2026-11-20");
    assert.equal(range("do mahine pehle"), "2026-09-01..2026-09-30");
    assert.equal(range("2 saal pehle"), "2024-01-01..2024-12-31");
    assert.equal(range("pichle weekend"), "2026-11-14..2026-11-15");
    assert.deepEqual(read("kal wale beach").words, ["beach"]); // the grammar words go
    assert.equal(range("is din"), "2026-11-20..2026-11-20"); // today
    // A People-page name wins; English words aren't dates.
    const kal = [person("kal", "Kal"), person("jo", "Jo")];
    assert.deepEqual([names("Kal and Jo at the beach", kal), read("Kal and Jo at the beach", kal).dates], [["kal", "jo"], null]);
    assert.equal(read("photos of the parson").dates, null);
  });
});

describe("time zones", () => {
  test("a day starts at the user's midnight", () => {
    assert.equal(startOfDay("2023-01-01", "Asia/Kolkata"), "2022-12-31T18:30:00.000Z");
    assert.equal(startOfDay("2023-01-01", "UTC"), "2023-01-01T00:00:00.000Z");
    // the day clocks go forward in New York: midnight is still EST (-5), the next day EDT (-4)
    assert.equal(startOfDay("2024-03-10", "America/New_York"), "2024-03-10T05:00:00.000Z");
    assert.equal(startOfDay("2024-03-11", "America/New_York"), "2024-03-11T04:00:00.000Z");
    assert.deepEqual(rangeInstants({ from: "2023-12-25", to: "2023-12-25" }, "Asia/Kolkata"), {
      gte: "2023-12-24T18:30:00.000Z", lt: "2023-12-25T18:30:00.000Z",
    });
  });

  test("today in the user's zone, and only real zones", () => {
    const now = new Date("2026-11-20T20:00:00Z"); // already the 21st in India
    assert.deepEqual(todayIn("Asia/Kolkata", now), { y: 2026, m: 11, d: 21 });
    assert.deepEqual(todayIn("UTC", now), { y: 2026, m: 11, d: 20 });
    assert.equal(isTimeZone("Asia/Kolkata"), true);
    // The Android app sends its current offset: the same instants as the zone's name.
    assert.equal(isTimeZone("+05:30"), true);
    const day = { from: "2026-01-01", to: "2026-01-01" };
    assert.deepEqual(rangeInstants(day, "+05:30"), rangeInstants(day, "Asia/Kolkata"));
    assert.equal(startOfDay("2026-01-01", "-04:30"), "2026-01-01T04:30:00.000Z");
    assert.equal(isTimeZone("Not/AZone"), false);
    assert.equal(isTimeZone(5), false);
  });
});
