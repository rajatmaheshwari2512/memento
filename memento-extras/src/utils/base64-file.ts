// Base64 to and from files, a piece at a time, so a photo is never whole in memory: an AI edit's
// images go to Gemini as base64 inside JSON, and its result comes back the same way
// (clients/gemini.client.ts); the apps send a highlighted edit's images that way too
// (schemas/edits.schema.ts).

import { open, type FileHandle } from "node:fs/promises";
import type { StringSink } from "./json-stream.ts";

// How much of a file is encoded at a time: a multiple of 3 bytes, so each piece encodes on its
// own (padding only at the very end). 48 KB of file is 64 KB of base64.
const READ_BYTES = 3 * 16 * 1024;

// How long `bytes` bytes are in base64, padding included.
export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

// The file's bytes in base64 (ASCII), a piece at a time.
export async function* base64OfFile(path: string): AsyncGenerator<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(READ_BYTES);
    let carry = 0; // bytes left from the last read (0–2), at the buffer's start
    for (;;) {
      const { bytesRead } = await file.read(buffer, carry, READ_BYTES - carry, null);
      const have = carry + bytesRead;
      if (bytesRead === 0) {
        if (have > 0) yield Buffer.from(buffer.subarray(0, have).toString("base64"), "latin1");
        return;
      }
      const whole = have - (have % 3);
      // A new buffer each time: whoever reads this may still hold the last one.
      if (whole > 0) yield Buffer.from(buffer.subarray(0, whole).toString("base64"), "latin1");
      buffer.copy(buffer, 0, whole, have);
      carry = have - whole;
    }
  } finally {
    await file.close();
  }
}

// What a lenient read ignores (Buffer.from(…, "base64") does the same): anything but base64's
// letters (the URL-safe ones too) and padding, e.g. line breaks.
const NOT_BASE64 = /[^A-Za-z0-9+/\-_=]/g;
const PLAIN = /^[A-Za-z0-9+/]*(=*)$/;
const PADDING = /^=*$/;

// A base64 string (from utils/json-stream.ts) decoded into a new file as it arrives, 4 characters
// at a time. Strict (what an app sends): only plain base64 is valid, as /^[A-Za-z0-9+/]+={0,2}$/
// says; otherwise (Gemini's reply) what isn't base64 is ignored. Nothing more is written once it's
// invalid or more than `maxBytes` would be, but it's still counted. Afterwards: how many
// characters came, how many bytes were written, whether it was valid, and its first bytes (to tell
// the image's type). close() must be called in the end, whatever happened.
export class Base64ToFile implements StringSink {
  readonly path: string;
  chars = 0;
  bytes = 0;
  valid = true;
  head: Buffer = Buffer.alloc(0);
  readonly #strict: boolean;
  readonly #maxBytes: number;
  #dataChars = 0;
  #padding = 0;
  #carry = "";
  #file: FileHandle | null = null;
  #closed = false;

  constructor(path: string, options: { strict: boolean; maxBytes: number }) {
    this.path = path;
    this.#strict = options.strict;
    this.#maxBytes = options.maxBytes;
  }

  async write(text: string): Promise<void> {
    if (this.#strict) this.#check(text);
    else text = text.replace(NOT_BASE64, "");
    this.chars += text.length;
    if (!this.#writing()) return;
    const all = this.#carry + text;
    const whole = all.length - (all.length % 4);
    this.#carry = all.slice(whole);
    if (whole > 0) await this.#put(Buffer.from(all.slice(0, whole), "base64"));
  }

  async end(): Promise<void> {
    if (this.#strict && this.#dataChars === 0) this.valid = false;
    if (this.#writing() && this.#carry) await this.#put(Buffer.from(this.#carry, "base64"));
    this.#carry = "";
    if (!this.#file && !this.#closed) this.#file = await open(this.path, "wx", 0o600); // even when empty
    await this.close();
  }

  async close(): Promise<void> {
    this.#closed = true;
    const file = this.#file;
    this.#file = null;
    await file?.close();
  }

  // Still worth writing: valid, and not already refused as too large (schemas/edits.schema.ts's rule).
  #writing(): boolean {
    return this.valid && !this.#closed && (this.chars * 3) / 4 <= this.#maxBytes + 2;
  }

  // Plain base64: letters, then at most two "=" at the very end.
  #check(text: string): void {
    if (!this.valid) return;
    if (this.#padding > 0) {
      if (PADDING.test(text)) this.#padding += text.length;
      else this.valid = false;
    } else {
      const plain = PLAIN.exec(text);
      if (!plain) this.valid = false;
      else {
        this.#padding = plain[1]!.length;
        this.#dataChars += text.length - this.#padding;
      }
    }
    if (this.#padding > 2) this.valid = false;
  }

  async #put(bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    this.#file ??= await open(this.path, "wx", 0o600);
    if (this.head.length < 12) this.head = Buffer.concat([this.head, bytes.subarray(0, 12 - this.head.length)]);
    for (let at = 0; at < bytes.length; ) at += (await this.#file.write(bytes, at, bytes.length - at)).bytesWritten;
    this.bytes += bytes.length;
  }
}
