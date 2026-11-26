// The EXIF block (date, time zone, place) a collage carries in its own file.

export type Stamp = {
  local: string; // wall-clock time where it happened, "2026-10-20T08:59:59"
  offset: string; // "+05:30"
  gps: { lat: number; lon: number } | null;
};

type Entry = { tag: number; type: 1 | 2 | 3 | 4 | 5 | 7; count: number; data: Buffer } | { tag: number; type: 4; count: 1; pointer: "exif" | "gps" };

function short(tag: number, value: number): Entry {
  const data = Buffer.alloc(2);
  data.writeUInt16LE(value);
  return { tag, type: 3, count: 1, data };
}

function long(tag: number, value: number): Entry {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return { tag, type: 4, count: 1, data };
}

function ascii(tag: number, text: string): Entry {
  const data = Buffer.from(`${text}\0`, "ascii");
  return { tag, type: 2, count: data.length, data };
}

function rationals(tag: number, values: Array<[number, number]>): Entry {
  const data = Buffer.alloc(values.length * 8);
  values.forEach(([n, d], i) => {
    data.writeUInt32LE(n, i * 8);
    data.writeUInt32LE(d, i * 8 + 4);
  });
  return { tag, type: 5, count: values.length, data };
}

function degrees(value: number): Array<[number, number]> {
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = Math.round(((abs - d) * 60 - m) * 60 * 10_000);
  return [[d, 1], [m, 1], [s, 10_000]];
}

function ifdSize(entries: Entry[]): number {
  let size = 2 + entries.length * 12 + 4;
  for (const e of entries) if ("data" in e && e.data.length > 4) size += e.data.length + (e.data.length % 2);
  return size;
}

function writeIfd(entries: Entry[], start: number, pointers: Record<"exif" | "gps", number>): Buffer {
  const out = Buffer.alloc(ifdSize(entries));
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  out.writeUInt16LE(sorted.length, 0);
  let extra = 2 + sorted.length * 12 + 4;
  sorted.forEach((e, i) => {
    const at = 2 + i * 12;
    out.writeUInt16LE(e.tag, at);
    out.writeUInt16LE(e.type, at + 2);
    out.writeUInt32LE(e.count, at + 4);
    if ("pointer" in e) {
      out.writeUInt32LE(pointers[e.pointer], at + 8);
    } else if (e.data.length <= 4) {
      e.data.copy(out, at + 8);
    } else {
      out.writeUInt32LE(start + extra, at + 8);
      e.data.copy(out, extra);
      extra += e.data.length + (e.data.length % 2);
    }
  });
  return out;
}

export function exifBlock({ local, offset, gps }: Stamp, size: { w: number; h: number }): Buffer {
  const when = local.replace("T", " ").replace(/-/g, ":").slice(0, 19);
  const exif: Entry[] = [
    { tag: 0x9000, type: 7, count: 4, data: Buffer.from("0232", "latin1") },
    ascii(0x9003, when), ascii(0x9004, when), ascii(0x9010, offset), ascii(0x9011, offset),
    short(0xa001, 1),
    long(0xa002, size.w), long(0xa003, size.h),
  ];
  const gpsEntries: Entry[] = gps
    ? [
        { tag: 0x0000, type: 1, count: 4, data: Buffer.from([2, 3, 0, 0]) },
        ascii(0x0001, gps.lat >= 0 ? "N" : "S"),
        rationals(0x0002, degrees(gps.lat)),
        ascii(0x0003, gps.lon >= 0 ? "E" : "W"),
        rationals(0x0004, degrees(gps.lon)),
      ]
    : [];
  const ifd0: Entry[] = [ascii(0x0131, "Memento"), { tag: 0x8769, type: 4, count: 1, pointer: "exif" }];
  if (gps) ifd0.push({ tag: 0x8825, type: 4, count: 1, pointer: "gps" });

  const pointers = { exif: 8 + ifdSize(ifd0), gps: 8 + ifdSize(ifd0) + ifdSize(exif) };
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const tiff = Buffer.concat([
    header,
    writeIfd(ifd0, 8, pointers),
    writeIfd(exif, pointers.exif, pointers),
    ...(gps ? [writeIfd(gpsEntries, pointers.gps, pointers)] : []),
  ]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const marker = Buffer.from([0xff, 0xe1, 0, 0]);
  marker.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([marker, body]);
}

// The JPEG (`size` pixels) with the block added after its start marker.
export function withExif(jpeg: Buffer, stamp: Stamp, size: { w: number; h: number }): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  return Buffer.concat([jpeg.subarray(0, 2), exifBlock(stamp, size), jpeg.subarray(2)]);
}
