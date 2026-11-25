// Ask Photos: how many results each search keeps, and the words and patterns the date reader
// and name matching use (services/ask.service.ts, ask-parser.service.ts, ask-reader.service.ts).

export const ASK_OFF = "Ask Photos is switched off. An admin can turn it on in Administration → Settings → Memento Features.";

export const SMART_RESULTS = 250; // the search model's best matches

export const CAPTION_RESULTS = 200; // caption matches, best first

// "The last time …": every caption match (up to this many) is sorted by date, so the newest
// is never cut for a weaker word match. Immich takes 2,000 IDs in one search (5,000 failed),
// so they go in batches.
export const DATED_CAPTIONS = 10_000;

export const IDS_PER_SEARCH = 2_000;

export const PAGE = 250; // photos per page when there are no words to rank by (newest first)

export const DATE_SORTED_SMART = 50; // "the last time …" with no caption match: the AI search's best 50 are sorted by date

// Reciprocal rank fusion: each list gives a photo 1 / (K + its place in that list), and the
// photo's score is the sum. 60 is the usual K; with it, a photo near the top of both lists
// beats one at the very top of only one.
export const RRF_K = 60;

export const PEOPLE_CACHE_MS = 60_000;

export const MAX_QUESTION_CHARS = 300;

// Words that never help find a photo: grammar, chat, question words, and sort or kind words.
// Left over from a phrase the model marked as a date, they aren't searched for ("pichle saal
// ki" → nothing, "my first birthday" → "birthday"), since the caption search needs every word.
// The reader's safety net also uses it: a People-page name that's one of these words ("Will",
// "May") counts only when the model marks it as a person.
export const FILLER = new Set(
  ("a an the at in on of with and or to for from by into onto over under near some any all every just only " +
    "my our your his her their its this that these those is are was were be been being i we you he she they it us " +
    "show find please " +
    // chat
    "kindly pls plz hey hi hello u na yaar wanna how everything anything something somewhere anywhere them doing during " +
    // Hindi grammar and request words
    "ki ka ke wali wala wale mein se ko hai hain tha thi dikhao dikha dikhado bhejo chahiye kar karo hua hui jo jab " +
    "bhi aur ya toh bas sab saare saari wo woh ye yeh unka unki uska uski " +
    // question words, which captions never contain
    "took taken take clicked captured shot see saw seen want need look looking have has had got " +
    "where when what which who whom do did does can could would may might will there here " +
    "go goes going went gone visit visited visiting gaya gaye gayi gye gya " +
    // sort and kind words ("my first birthday", "last year's pics")
    "first last time times photo photos pic pics picture pictures video videos")
    .split(" "),
);

// Small words that only join things together. When one of them ends up next to something
// the date reader took out ("photos of June 2024" → "of"), it goes too.
export const JOINERS = new Set([
  "and", "&", "+", ",", "with", "of", "from", "in", "during", "on", "at", "or", "taken", "my", "our", "the", "a",
  "all", "every", "any", "just", "only", "between", "since", "around", "when", "where", "while", "was", "were", "is",
  "are", "am", "i'm", "i’m", "together", "both",
]);

export const CUT = "\u0000"; // stands in for a piece the reader took out

export const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11,
  nov: 11, december: 12, dec: 12,
};

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const MONTH = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?";

export const YEAR = "(?<!\\d)(19[5-9]\\d|20\\d\\d)(?!\\d)";

export const DAY = "(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?";

export const NUMBER = "(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";

export const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// "every year" searches (Christmas, birthdays) start here at the earliest.
export const EARLIEST_YEAR = 1990;

export const BEFORE = "(?<![\\p{L}\\p{N}])";

export const AFTER = "(?![\\p{L}\\p{N}])";

export const POSSESSIVE = "(?:['’]s|s['’])?";

// The trained reader (services/ask-reader.service.ts). A face named like a relation also
// answers to that relation's other words ("Mummy" ← "maa", "mom"). Ambiguous words ("mama":
// mother or uncle; "grandma": nani or dadi) are left out.
export const RELATIONS: readonly (readonly string[])[] = [
  ["mom", "mommy", "mummy", "mumma", "mum", "maa", "amma", "ammi", "mother", "mamma", "mumy", "mummi", "momy"],
  ["dad", "daddy", "papa", "pappa", "father", "pitaji", "abbu", "dady", "pops"],
  ["nani", "nanima"],
  ["dadi", "dadima", "dadi maa"],
  ["nana", "nanaji"],
  ["dada", "dadaji"],
  ["didi", "sis", "sister", "behen"],
  ["bhaiya", "bhai", "bro", "brother"],
];

// First-person words the reader may label as a person: the asker. The same list as the reader's
// (reader/common.py, FIRST_PERSON); a test keeps them in step.
export const FIRST_PERSON = new Set([
  "me", "myself", "i", "i'm", "im", "i'am", "i've", "ive", "i'd", "self",
  "main", "mai", "mein", "mujhe", "muje", "mujhko", "maine", "mene", "khud", "meri", "mera", "mere", "apun",
]);

// What the reader may answer: B-/I- for each kind of phrase, or O for any other word.
export const READER_LABEL = /^(O|[BI]-(PER|DATE|NEW|OLD|VIDEO|FAV|WORD|PLACE))$/;

// Hinglish dates (Hindi in Latin letters): the units, and numbers as words.
export const HINDI_UNIT: Record<string, string> = {
  din: "day", dino: "day", dinon: "day",
  hafte: "week", hafta: "week", hafton: "week", hapte: "week",
  mahine: "month", mahina: "month", mahino: "month", mahinon: "month",
  saal: "year", sal: "year", saalon: "year", salon: "year", baras: "year", varsh: "year",
};
export const HINDI_UNITS = Object.keys(HINDI_UNIT).sort((a, b) => b.length - a.length).join("|");
export const HINDI_NUMBER_WORDS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6,
  saat: 7, aath: 8, nau: 9, das: 10,
};
export const HINDI_NUMBER = `(\\d{1,3}|${Object.keys(HINDI_NUMBER_WORDS).join("|")})`;

// Places (services/ask-places.service.ts): how long a user's list of places is kept; Ask never
// waits longer than PLACES_WAIT_MS for it (or for Immich's place search), and after a failed
// read asks again a minute later.
export const PLACES_CACHE_MS = 10 * 60_000;
export const PLACES_WAIT_MS = 1_500;
export const PLACES_RETRY_MS = 60_000;
