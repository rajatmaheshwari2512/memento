// Image types the service accepts from Immich and serves back. Checked by the file's
// first bytes, not by what a server claims, because anything served under
// photos.<domain>/extras runs with the user's Immich login: an HTML or SVG file there
// could act as the user. So only these raster formats ever leave this service.

import { open } from "node:fs/promises";
import type { ImageMime } from "../types/image.types.ts";

export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}

// The pixel size of a JPEG or PNG file on disk, from its header (a JPEG's frame header, after
// whatever comes before it; a PNG's IHDR), reading only those bytes. Null if it isn't found.
export async function imageFileSize(path: string, mime: ImageMime): Promise<{ width: number; height: number } | null> {
  const file = await open(path, "r");
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      return bytesRead === length ? buffer : null;
    };
    if (mime === "image/png") {
      const header = await read(16, 8);
      return header && { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
    }
    if (mime !== "image/jpeg") return null;
    let position = 2;
    for (let segments = 0; segments < 1000; segments++) {
      const marker = await read(position, 4);
      if (!marker || marker[0] !== 0xff) return null;
      const kind = marker[1]!;
      // Frame headers (SOF0–15), but not DHT (C4), JPG (C8) or DAC (CC).
      if (kind >= 0xc0 && kind <= 0xcf && kind !== 0xc4 && kind !== 0xc8 && kind !== 0xcc) {
        const frame = await read(position + 5, 4);
        return frame && { height: frame.readUInt16BE(0), width: frame.readUInt16BE(2) };
      }
      position += 2 + marker.readUInt16BE(2);
    }
    return null;
  } finally {
    await file.close();
  }
}

export function extensionFor(mime: ImageMime): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}
