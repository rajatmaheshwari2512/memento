// Ask Photos with the trained reader (memento-extras/reader/): the model labels each word of the question; people, dates and places are then looked up for the asker (ask-parser.service.ts, readPhrase). If the model is slow, down or answers something odd, the caller searches the question as is.

import { readQuestion } from "../clients/reader.client.ts";
import { FILLER, FIRST_PERSON, RELATIONS } from "../constants/ask.constants.ts";
import { findMe, meHint, readDate, readPhrase } from "./ask-parser.service.ts";
import type { Person, Plan, ReaderContext, ReaderReply, ReaderSpan } from "../types/ask.types.ts";
import { hasRun, wordsOf } from "../utils/words.ts";

// "Mom's" → "mom", "Vikas'" → "vikas", "I’m" → "i'm" (phones type the curly apostrophe).
const stripPossessive = (word: string) => word.toLowerCase().replace(/’/gu, "'").replace(/'s$/u, "").replace(/(?<=s)'$/u, "");
// The asker: one of the first-person words, or "I am" marked as one phrase.
const isFirstPerson = (plain: string) => FIRST_PERSON.has(plain) || plain === "i am";

// The labelled phrases, in order: "B-DATE I-DATE" is one date.
export function spansOf({ tokens, tags }: ReaderReply): ReaderSpan[] {
  const spans: ReaderSpan[] = [];
  tags.forEach((tag, i) => {
    if (tag === "O") return;
    const kind = tag.slice(2);
    const last = spans.at(-1);
    if (tag.startsWith("I-") && last && last.kind === kind && last.start + last.words.length === i) last.words.push(tokens[i]!);
    else spans.push({ kind, start: i, words: [tokens[i]!] });
  });
  return spans;
}

// A phrase the model marked as a person → a face on the asker's People page, or null.
function faceFor(mention: string, ctx: ReaderContext): Person | null {
  const plain = stripPossessive(mention.trim());
  if (isFirstPerson(plain)) return findMe(ctx.people, ctx.accountName);
  const matched = readPhrase(mention, ctx).people[0];
  if (matched) return ctx.people.find((p) => p.id === matched.id) ?? null;
  const group = RELATIONS.find((g) => g.includes(plain));
  return group ? (ctx.people.find((p) => group.includes(p.name.trim().toLowerCase())) ?? null) : null;
}

export function planFromReply(question: string, reply: ReaderReply, ctx: ReaderContext): Plan {
  const spans = spansOf(reply);
  const people: Plan["people"] = [];
  const hints: string[] = [];
  const words: string[] = [];
  const addPerson = (p: { id: string; name: string }) => {
    if (!people.some((x) => x.id === p.id)) people.push({ id: p.id, name: p.name });
  };
  const addHint = (hint: string) => {
    if (!hints.includes(hint)) hints.push(hint);
  };
  const personWords = new Set<string>();

  for (const span of spans.filter((s) => s.kind === "PER")) {
    const mention = span.words.join(" ");
    const face = faceFor(mention, ctx);
    if (face) {
      addPerson(face);
      wordsOf(mention).forEach((w) => personWords.add(w));
    } else if (isFirstPerson(stripPossessive(mention.trim()))) {
      addHint(meHint(ctx.accountName));
    }
  }

  const datePhrase = spans.filter((s) => s.kind === "DATE").map((s) => s.words.join(" ")).join(" ");
  const dateWords = new Set(wordsOf(datePhrase));
  let dates: Plan["dates"] = null;
  const undated: string[] = []; // date words the date reader can't convert ("diwali", "summer")
  if (datePhrase) {
    const read = readDate(datePhrase, ctx);
    dates = read.dates;
    read.people.forEach(addPerson);
    read.words.forEach((w) => {
      if (!words.includes(w)) words.push(w);
      undated.push(w);
    });
    read.hints.forEach(addHint);
  }

  // The safety net: People-page names in the question that the model didn't mark.
  const things = new Set(spans.filter((s) => s.kind === "WORD" || s.kind === "PLACE").flatMap((s) => s.words.flatMap(wordsOf)));
  const questionWords = wordsOf(question);
  const me = findMe(ctx.people, ctx.accountName);
  for (const p of readPhrase(question, ctx).people) {
    if (p.id === me?.id) continue;
    const parts = wordsOf(p.name);
    if (parts.some((w) => things.has(w) || dateWords.has(w))) continue;
    if (FILLER.has(parts[0]!) && !(parts.length > 1 && hasRun(questionWords, parts))) continue;
    addPerson(p);
  }

  // Things and places, as the model marked them: the caption search's words, and the search model's text. When the model marked nothing, the question goes as it is.
  const searched = spans.filter((s) => s.kind === "WORD" || s.kind === "PLACE");
  for (const w of searched.flatMap((s) => s.words.flatMap((t) => wordsOf(stripPossessive(t))))) {
    if (!personWords.has(w) && !dateWords.has(w) && !words.includes(w)) words.push(w);
  }
  const text = spans.length === 0 ? question.trim() : [...searched.flatMap((s) => s.words), ...undated].join(" ");
  const sort = spans.find((s) => s.kind === "NEW" || s.kind === "OLD");
  return {
    text,
    words,
    people,
    dates,
    type: spans.some((s) => s.kind === "VIDEO") ? "VIDEO" : null,
    favorite: spans.some((s) => s.kind === "FAV"),
    order: sort ? (sort.kind === "NEW" ? "newest" : "oldest") : null,
    hints,
    places: spans.filter((s) => s.kind === "PLACE").map((s) => s.words.join(" ")),
  };
}

// The question read by the trained model, or null (slow, down, odd reply): then it's searched as typed.
export async function readWithModel(question: string, ctx: ReaderContext): Promise<Plan | null> {
  const reply = await readQuestion(question);
  return reply ? planFromReply(question, reply, ctx) : null;
}
