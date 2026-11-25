// Small vips helpers shared by every kind of creation.

import type { Size } from "./layout.ts";
import { type Deadline, run } from "./run.ts";

export async function sizeOf(file: string, deadline: Deadline): Promise<Size> {
  const width = Number((await run("vipsheader", ["-f", "width", file], deadline)).trim());
  const height = Number((await run("vipsheader", ["-f", "height", file], deadline)).trim());
  if (!(width > 0 && height > 0)) throw new Error("couldn't read a photo's size");
  return { w: width, h: height };
}

// The header of a binary PNM, the plain pixel files vips writes for our own maths (comments
// allowed, as vips writes one): its kind (P5 grey, P6 colour), size, largest value, and where
// the pixels start.
export function pnmHeader(bytes: Uint8Array): { magic: string; w: number; h: number; max: number; offset: number } {
  const space = (b: number | undefined) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
  let pos = 0;
  const token = () => {
    for (;;) {
      while (pos < bytes.length && space(bytes[pos])) pos++;
      if (bytes[pos] !== 0x23) break;
      while (pos < bytes.length && bytes[pos] !== 0x0a) pos++; // a comment
    }
    const start = pos;
    while (pos < bytes.length && !space(bytes[pos])) pos++;
    return Buffer.from(bytes.subarray(start, pos)).toString("latin1");
  };
  const magic = token();
  const w = Number(token());
  const h = Number(token());
  const max = Number(token());
  return { magic, w, h, max, offset: pos + 1 }; // after the single whitespace before the pixels
}
