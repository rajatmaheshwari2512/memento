// Reads JSON as it arrives, without ever holding all of it. For each value, by where it sits (its
// path of keys and indexes), the caller says what to do with it: keep it, skip it, or (a string)
// stream it to a sink a piece at a time, e.g. a photo in base64 decoded straight into a file
// (utils/base64-file.ts). Used for an AI edit's request with its images and for Gemini's reply
// with its image (schemas/edits.schema.ts, clients/gemini.client.ts), so neither is ever whole in
// memory.
//
// Kept strings and numbers are finished by JSON.parse itself, so they come out exactly as
// JSON.parse would give them. A streamed string's escapes (\/, =, ...) are decoded before
// they reach the sink, even when one is split between two pieces.

export type JsonPath = ReadonlyArray<string | number>;

// What to do with a value:
//   keep    keep it whole;
//   open    an object or array is kept, and each value in it asked about in turn; anything else
//           is kept;
//   skip    leave it out (an object's key is left out; an array keeps its place, as undefined);
//   stream  a string goes to the sink as it arrives (and is left out); anything else is kept.
export type JsonRoute = "keep" | "open" | "skip" | "stream";

// Receives a streamed string's text, escapes decoded, a piece at a time.
export type StringSink = { write(text: string): Promise<void>; end(): Promise<void> };

export type JsonStreamOptions = {
  route: (path: JsonPath) => JsonRoute;
  sink: (path: JsonPath) => StringSink;
  maxBytes: number; // the whole JSON
  maxKeptBytes: number; // everything kept, together (strings, numbers, keys, and the brackets and commas around them)
  maxStringBytes?: number; // one kept string: the rest of a longer one is dropped (default: no limit)
  maxDepth?: number; // objects and arrays inside each other, kept or not (default 64)
  tooLarge: () => Error;
  invalid: () => Error; // not JSON
};

// The kept part of the JSON, or undefined when there was nothing at all (an empty body).
export async function readJsonStream(source: AsyncIterable<Uint8Array>, options: JsonStreamOptions): Promise<unknown> {
  const reader = new JsonStreamReader(options);
  for await (const chunk of source) await reader.push(chunk);
  return reader.end();
}

const SKIPPED = Symbol("skipped");
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

type Frame = {
  kind: "object" | "array";
  mode: "keep" | "open" | "skip"; // keep: every value kept; open: each value routed; skip: nothing kept
  value: Record<string, unknown> | unknown[] | null;
  state: "first" | "key" | "colon" | "value" | "after";
  key: string | null;
  index: number;
};

type Text = {
  role: "key" | "value";
  mode: "keep" | "skip" | "stream";
  pieces: Buffer[]; // keep: the raw bytes, escapes and all
  size: number;
  truncated: boolean;
  escaped: boolean; // keep/skip: the last byte was an escaping backslash
  sink: StringSink | null; // stream
  decoder: TextDecoder | null; // stream
  escape: string | null; // stream: an escape being read (after its backslash)
};

type Scalar = { keep: boolean; text: string };

class JsonStreamReader {
  readonly #options: JsonStreamOptions;
  readonly #stack: Frame[] = [];
  #text: Text | null = null;
  #scalar: Scalar | null = null;
  #total = 0;
  #kept = 0;
  #done = false;
  #result: unknown = undefined;

  constructor(options: JsonStreamOptions) {
    this.#options = options;
  }

  async push(chunk: Uint8Array): Promise<void> {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.#total += bytes.length;
    if (this.#total > this.#options.maxBytes) throw this.#options.tooLarge();
    let i = 0;
    while (i < bytes.length) {
      if (this.#text) {
        i = this.#text.mode === "stream" ? await this.#streamed(bytes, i) : this.#inText(bytes, i);
      } else if (this.#scalar) {
        i = this.#inScalar(bytes, i);
      } else {
        const c = bytes[i]!;
        if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
        else if (isScalarByte(c) && this.#expectsValue()) this.#beginValue(c); // read from here by #inScalar
        else {
          this.#structure(c);
          i++;
        }
      }
    }
  }

  end(): unknown {
    if (this.#scalar) this.#endScalar();
    if (this.#text || this.#stack.length > 0) throw this.#options.invalid();
    if (this.#total === 0) return undefined;
    if (!this.#done) throw this.#options.invalid();
    return this.#result;
  }

  #invalid(): Error {
    return this.#options.invalid();
  }

  #expectsValue(): boolean {
    const frame = this.#stack.at(-1);
    if (!frame) return !this.#done;
    return frame.kind === "object" ? frame.state === "value" : frame.state === "first" || frame.state === "value";
  }

  #structure(c: number): void {
    const frame = this.#stack.at(-1);
    // What a kept object or array is made of counts too: a body of empty arrays is no lighter.
    if (frame?.mode !== "skip") this.#keep(1);
    if (!frame) {
      if (this.#done) throw this.#invalid();
      return this.#beginValue(c);
    }
    if (frame.kind === "object") {
      if ((frame.state === "first" || frame.state === "after") && c === 0x7d) return this.#close();
      if (frame.state === "first" || frame.state === "key") {
        if (c !== QUOTE) throw this.#invalid();
        this.#text = newText("key", frame.mode === "skip" ? "skip" : "keep");
        return;
      }
      if (frame.state === "colon") {
        if (c !== 0x3a) throw this.#invalid();
        frame.state = "value";
        return;
      }
      if (frame.state === "value") return this.#beginValue(c);
      if (c !== 0x2c) throw this.#invalid();
      frame.state = "key";
      return;
    }
    if (frame.state === "first" && c === 0x5d) return this.#close();
    if (frame.state === "first" || frame.state === "value") return this.#beginValue(c);
    if (c === 0x5d) return this.#close();
    if (c !== 0x2c) throw this.#invalid();
    frame.state = "value";
  }

  // What to do with the value starting here.
  #route(): JsonRoute {
    const parent = this.#stack.at(-1);
    if (parent && parent.mode !== "open") return parent.mode;
    return this.#options.route(this.#stack.map((f) => (f.kind === "object" ? f.key! : f.index)));
  }

  #beginValue(c: number): void {
    const route = this.#route();
    if (c === 0x7b || c === 0x5b) {
      if (this.#stack.length >= (this.#options.maxDepth ?? 64)) throw this.#options.tooLarge();
      const mode = route === "skip" ? "skip" : route === "open" ? "open" : "keep";
      const value = mode === "skip" ? null : c === 0x7b ? {} : [];
      this.#stack.push({ kind: c === 0x7b ? "object" : "array", mode, value, state: "first", key: null, index: 0 });
      return;
    }
    if (c === QUOTE) {
      const mode = route === "stream" ? "stream" : route === "skip" ? "skip" : "keep";
      this.#text = newText("value", mode);
      if (mode === "stream") {
        this.#text.sink = this.#options.sink(this.#stack.map((f) => (f.kind === "object" ? f.key! : f.index)));
        this.#text.decoder = new TextDecoder();
      }
      return;
    }
    if (!isScalarByte(c)) throw this.#invalid();
    this.#scalar = { keep: route !== "skip", text: "" };
  }

  // A value is complete: into its object or array (or it's the whole JSON).
  #add(value: unknown): void {
    const parent = this.#stack.at(-1);
    if (!parent) {
      this.#result = value === SKIPPED ? undefined : value;
      this.#done = true;
      return;
    }
    if (parent.value !== null) {
      if (Array.isArray(parent.value)) parent.value.push(value === SKIPPED ? undefined : value);
      else if (value !== SKIPPED) {
        // As JSON.parse does: an own property, even for "__proto__".
        Object.defineProperty(parent.value, parent.key!, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    if (parent.kind === "array") parent.index++;
    parent.state = "after";
  }

  #close(): void {
    const frame = this.#stack.pop()!;
    this.#add(frame.mode === "skip" ? SKIPPED : frame.value);
  }

  #keep(bytes: number): void {
    this.#kept += bytes;
    if (this.#kept > this.#options.maxKeptBytes) throw this.#options.tooLarge();
  }

  // A key or a kept or skipped string, from `i`: up to its closing quote, minding escapes.
  #inText(bytes: Buffer, i: number): number {
    const text = this.#text!;
    let j = i;
    let quote = -2;
    let backslash = -2;
    let end = -1;
    while (j < bytes.length) {
      if (text.escaped) {
        text.escaped = false;
        j++;
        continue;
      }
      if (quote !== -1 && quote < j) quote = bytes.indexOf(QUOTE, j);
      if (backslash !== -1 && backslash < j) backslash = bytes.indexOf(BACKSLASH, j);
      if (backslash !== -1 && (quote === -1 || backslash < quote)) {
        text.escaped = true;
        j = backslash + 1;
        continue;
      }
      if (quote !== -1) end = quote;
      break;
    }
    const stop = end === -1 ? bytes.length : end;
    if (text.mode === "keep" && stop > i) {
      const room = text.role === "value" ? (this.#options.maxStringBytes ?? Infinity) - text.size : Infinity;
      const take = Math.min(stop - i, Math.max(0, room));
      if (take < stop - i) text.truncated = true;
      if (take > 0) {
        this.#keep(take);
        text.pieces.push(Buffer.from(bytes.subarray(i, i + take))); // a copy: the chunk isn't held
        text.size += take;
      }
    }
    if (end === -1) return bytes.length;
    this.#endText();
    return end + 1;
  }

  #endText(): void {
    const text = this.#text!;
    this.#text = null;
    if (text.mode === "skip") {
      if (text.role === "key") this.#stack.at(-1)!.state = "colon";
      else this.#add(SKIPPED);
      return;
    }
    const value = parseString(Buffer.concat(text.pieces).toString("utf8"), text.truncated);
    if (value === null) throw this.#invalid();
    if (text.role === "value") return this.#add(value);
    const frame = this.#stack.at(-1)!;
    frame.key = value;
    frame.state = "colon";
  }

  // A streamed string, from `i`: its text goes to the sink, a piece per chunk.
  async #streamed(bytes: Buffer, i: number): Promise<number> {
    const text = this.#text!;
    let out = "";
    let j = i;
    while (j < bytes.length) {
      if (text.escape !== null) {
        text.escape += String.fromCharCode(bytes[j]!);
        j++;
        const decoded = unescape(text.escape);
        if (decoded === undefined) throw this.#invalid();
        if (decoded !== null) {
          out += decoded;
          text.escape = null;
        }
        continue;
      }
      let stop = bytes.indexOf(QUOTE, j);
      const backslash = bytes.indexOf(BACKSLASH, j);
      if (backslash !== -1 && (stop === -1 || backslash < stop)) stop = backslash;
      if (stop === -1) stop = bytes.length;
      out += text.decoder!.decode(bytes.subarray(j, stop), { stream: true });
      if (stop === bytes.length) {
        j = stop;
        break;
      }
      if (bytes[stop] === BACKSLASH) {
        text.escape = "";
        j = stop + 1;
        continue;
      }
      out += text.decoder!.decode();
      if (out) await text.sink!.write(out);
      await text.sink!.end();
      this.#text = null;
      this.#add(SKIPPED);
      return stop + 1;
    }
    if (out) await text.sink!.write(out);
    return j;
  }

  // A number, true, false or null, from `i`: until the byte after it.
  #inScalar(bytes: Buffer, i: number): number {
    const scalar = this.#scalar!;
    let j = i;
    while (j < bytes.length && isScalarByte(bytes[j]!)) j++;
    if (scalar.keep) {
      this.#keep(j - i);
      scalar.text += bytes.toString("latin1", i, j);
    }
    if (j < bytes.length) this.#endScalar();
    return j;
  }

  #endScalar(): void {
    const scalar = this.#scalar!;
    this.#scalar = null;
    if (!scalar.keep) return this.#add(SKIPPED);
    let value: unknown;
    try {
      value = JSON.parse(scalar.text);
    } catch {
      throw this.#invalid();
    }
    this.#add(value);
  }
}

const newText = (role: Text["role"], mode: Text["mode"]): Text => ({
  role, mode, pieces: [], size: 0, truncated: false, escaped: false, sink: null, decoder: null, escape: null,
});

// Digits, letters, + - and . : what numbers, true, false and null are made of.
function isScalarByte(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x2b || c === 0x2d || c === 0x2e;
}

// A kept string's raw text (between its quotes) as JSON.parse reads it, or null if it isn't valid.
// One cut short (maxStringBytes) may end inside an escape: that part is dropped.
function parseString(raw: string, truncated: boolean): string | null {
  for (let cut = 0; cut <= (truncated ? 6 : 0); cut++) {
    try {
      return JSON.parse(`"${raw.slice(0, raw.length - cut)}"`) as string;
    } catch {
      // try a little shorter (truncated only)
    }
  }
  return null;
}

// An escape after its backslash: its text when complete, null when more is needed, undefined
// when it isn't a valid one.
function unescape(escape: string): string | null | undefined {
  if (escape[0] === "u") {
    if (escape.length < 5) return /^u[0-9a-fA-F]*$/.test(escape) ? null : undefined;
    return /^u[0-9a-fA-F]{4}$/.test(escape) ? String.fromCharCode(parseInt(escape.slice(1), 16)) : undefined;
  }
  return SIMPLE_ESCAPES[escape];
}

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
