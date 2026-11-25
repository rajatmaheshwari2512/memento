// The creations container's pure parts (memento-extras/creations/src): collage layouts and
// face-keeping crops, the EXIF block collages carry, the checks on a job, and the quality maths.
// The rendering itself (vips, ffmpeg) is checked by building the image and rendering samples
// (docs/runbooks.md, "Creations").

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { freePort } from "./helpers.ts";
import { Deadline, pipeline, run } from "../creations/src/run.ts";
import { exifBlock, withExif } from "../creations/src/exif.ts";
import { alike, burstStretch, playOrder } from "../creations/src/animation.ts";
import { frameSize } from "../creations/src/video.ts";
import { BadJob, type Mood, NOISE_UNSUITABLE, parseJob, parseQualityJob, Unsuitable } from "../creations/src/job.ts";
import { chooseLayout, cropFor, GUTTER, type Box } from "../creations/src/layout.ts";
import { measure, parsePnm } from "../creations/src/quality.ts";
import { pickTrack } from "../creations/src/recap.ts";
import { joinGraph, noisePieces, soundCapBytes, soundOf, soundOptions } from "../creations/src/noise.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("layouts: the shapes that crop least, equal gutters, every photo placed once", () => {
  const portrait = { w: 1080, h: 1440 };
  const landscape = { w: 1440, h: 1080 };
  const two = chooseLayout([portrait, portrait]);
  assert.deepEqual(two.canvas, { w: 2400, h: 1800 }, "two portraits side by side");
  assert.ok(two.cells.every((c) => c.h > c.w));
  const three = chooseLayout([landscape, portrait, landscape]);
  const tall = three.cells.findIndex((c) => c.h > c.w);
  assert.equal(three.order[tall], 1, "the portrait gets the tall cell");
  for (const n of [2, 3, 4, 6]) {
    const layout = chooseLayout(Array.from({ length: n }, (_, i) => (i % 2 ? portrait : landscape)));
    assert.deepEqual([...layout.order].sort(), Array.from({ length: n }, (_, i) => i));
    for (const c of layout.cells) {
      assert.ok(c.x >= GUTTER && c.y >= GUTTER && c.x + c.w <= layout.canvas.w - GUTTER + 1 && c.y + c.h <= layout.canvas.h - GUTTER + 1);
    }
  }
  assert.throws(() => chooseLayout([landscape, landscape, landscape, landscape, landscape]));
});

test("crops keep faces in, with a little headroom; without faces, the middle", () => {
  const photo = { w: 4000, h: 3000 };
  const tallCell = { x: 0, y: 0, w: 600, h: 1200 };
  const inside = (crop: { x: number; y: number; w: number; h: number }, [x1, y1, x2, y2]: Box) =>
    crop.x <= x1 * photo.w && crop.y <= y1 * photo.h && crop.x + crop.w >= x2 * photo.w && crop.y + crop.h >= y2 * photo.h;
  const right: Box = [0.85, 0.2, 0.95, 0.35];
  const crop = cropFor(photo, [right], tallCell);
  assert.ok(inside(crop, right));
  assert.equal(crop.x + crop.w, 4000, "pushed against the edge rather than cutting the face");
  assert.ok(Math.abs(crop.w / crop.h - 0.5) < 0.01);
  const plain = cropFor(photo, [], tallCell);
  assert.equal(plain.x, Math.round((4000 - plain.w) / 2));
  // Two faces too far apart for the crop: the bigger one is kept whole.
  const big: Box = [0.05, 0.3, 0.25, 0.6];
  const small: Box = [0.9, 0.3, 0.95, 0.35];
  const both = cropFor(photo, [big, small], tallCell);
  assert.ok(inside(both, big) && !inside(both, small));
});

function exifStrings(block: Buffer): string {
  return block.toString("latin1");
}

test("the EXIF block: date, time zone and place as Immich reads them", () => {
  const stamp = { local: "2026-10-20T08:59:59", offset: "+05:30", gps: { lat: 15.4989, lon: -73.8278 } };
  const block = exifBlock(stamp, { w: 2400, h: 1800 });
  assert.equal(block.readUInt16BE(0), 0xffe1);
  assert.equal(block.readUInt16BE(2), block.length - 2);
  const text = exifStrings(block);
  assert.ok(text.includes("Exif\0\0II*\0"));
  assert.ok(text.includes("2026:10:20 08:59:59\0") && text.includes("+05:30\0") && text.includes("Memento\0"));
  assert.ok(text.includes("W\0"), "west of Greenwich");
  // GPS latitude 15° 29' 56.04": three rationals.
  const tiff = block.subarray(10);
  const at = tiff.indexOf(Buffer.from([15, 0, 0, 0, 1, 0, 0, 0]));
  assert.ok(at > 0);
  assert.deepEqual([tiff.readUInt32LE(at + 8), tiff.readUInt32LE(at + 16), tiff.readUInt32LE(at + 20)], [29, 560400, 10000]);
  const noPlace = exifStrings(exifBlock({ ...stamp, gps: null }, { w: 10, h: 10 }));
  assert.ok(!noPlace.includes("W\0"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2]);
  const out = withExif(jpeg, stamp, { w: 10, h: 10 });
  assert.deepEqual([...out.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe1]);
  assert.deepEqual([...out.subarray(-4)], [0xff, 0xdb, 1, 2]);
  assert.throws(() => withExif(Buffer.from("nope"), stamp, { w: 1, h: 1 }));
});

test("jobs name only files in their own folder, and only sensible values", () => {
  const photo = { file: "0.jpg", faces: [[0.1, 0.1, 0.2, 0.2]] };
  const stamp = { local: "2026-10-20T08:59:59", offset: "+05:30", gps: null };
  const good = { id: ID, kind: "collage", photos: [photo, { file: "1.jpg", faces: [] }], stamp };
  const parsed = parseJob(good);
  assert.equal(parsed.kind === "collage" ? parsed.photos.length : 0, 2);
  for (const bad of [
    { ...good, id: "../x" },
    { ...good, kind: "rm" },
    { ...good, photos: [photo] },
    { ...good, photos: [{ ...photo, file: "../../data.db" }, photo] },
    { ...good, photos: [{ ...photo, file: "/etc/passwd" }, photo] },
    { ...good, photos: [{ ...photo, faces: [[0.5, 0.5, 0.2, 0.9]] }, photo] },
    { ...good, stamp: { ...stamp, local: "yesterday" } },
    { ...good, stamp: { ...stamp, gps: { lat: 100, lon: 0 } } },
  ]) assert.throws(() => parseJob(bad), BadJob, JSON.stringify(bad).slice(0, 80));
  const recap = { id: ID, kind: "recap", stamp, items: [photo, { kind: "video", file: "1.mp4", durationMs: 8000 }, { ...photo, kind: "photo" }] };
  assert.equal((recap.items[0] as any).kind, undefined);
  assert.throws(() => parseJob(recap), BadJob, "every item says what it is");
  recap.items[0] = { ...photo, kind: "photo" } as any;
  const parsedRecap = parseJob(recap);
  assert.deepEqual(parsedRecap.kind === "recap" ? parsedRecap.items.map((i) => i.kind) : [], ["photo", "video", "photo"]);
  assert.deepEqual(parsedRecap.kind === "recap" ? parsedRecap.moods : null, [], "no moods given: none");
  const withMoods = parseJob({ ...recap, moods: ["festive", "indian-calm"] });
  assert.deepEqual(withMoods.kind === "recap" ? withMoods.moods : null, ["festive", "indian-calm"]);
  for (const bad of [
    { ...recap, moods: "festive" },
    { ...recap, moods: ["Festive"] },
    { ...recap, moods: ["festive-"] },
    { ...recap, moods: ["../music/x"] },
    { ...recap, moods: [1] },
    { ...recap, moods: Array(8).fill("calm") },
    { ...recap, items: recap.items.slice(0, 2) },
    { ...recap, items: [...recap.items.slice(0, 2), { kind: "video", file: "2.mp4", durationMs: -1 }] },
    { ...recap, items: [...recap.items.slice(0, 2), { kind: "video", file: "../2.mp4", durationMs: 1000 }] },
  ]) assert.throws(() => parseJob(bad), BadJob);
  const animation = { id: ID, kind: "animation", stamp, frames: ["0.jpg", "1.jpg", "2.jpg"] };
  assert.deepEqual(parseJob(animation), animation);
  for (const bad of [
    { ...animation, frames: ["0.jpg", "1.jpg"] },
    { ...animation, frames: Array.from({ length: 13 }, (_, i) => `${i}.jpg`) },
    { ...animation, frames: ["0.jpg", "1.jpg", "../2.jpg"] },
    { ...animation, frames: ["0.jpg", "1.jpg", { file: "2.jpg" }] },
    { ...animation, frames: "0.jpg" },
  ]) assert.throws(() => parseJob(bad), BadJob, JSON.stringify(bad).slice(0, 80));
  const cinematic = { id: ID, kind: "cinematic", stamp, photo };
  assert.deepEqual(parseJob(cinematic), cinematic);
  for (const bad of [
    { ...cinematic, photo: { ...photo, file: "../0.jpg" } },
    { ...cinematic, photo: "0.jpg" },
    { ...cinematic, photo: undefined },
    { ...cinematic, photo: { ...photo, faces: [[0, 0, 2, 2]] } },
  ]) assert.throws(() => parseJob(bad), BadJob, JSON.stringify(bad).slice(0, 80));
  const noise = { id: ID, kind: "reduce-noise", video: "video.mov", format: "mov" };
  assert.deepEqual(parseJob(noise), noise);
  for (const bad of [
    { ...noise, video: "../video.mov" },
    { ...noise, video: "video.mp4" }, // not the format it says
    { ...noise, format: "avi", video: "video.avi" },
    { ...noise, video: undefined },
    { ...noise, video: "video.jpg", format: "jpg" },
  ]) assert.throws(() => parseJob(bad), BadJob, JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(parseQualityJob({ id: ID, files: ["0.webp"] }).files, ["0.webp"]);
  assert.throws(() => parseQualityJob({ id: ID, files: ["../0.webp"] }), BadJob);
  assert.throws(() => parseQualityJob({ id: ID, files: [] }), BadJob);
});

test("reduce noise: the sound in pieces of ~2 minutes whose kept parts crossfade back to exactly its length, each with 2 s before it", () => {
  const rate = 48_000;
  assert.deepEqual(noisePieces(60 * rate), [{ from: 0, to: 60 * rate, keepFrom: 0, keepTo: 60 * rate }], "a minute: one piece");
  for (const seconds of [125, 240, 359.5, 600, 600.4]) {
    const total = Math.round(seconds * rate);
    const pieces = noisePieces(total);
    // Kept lengths add up to the whole once each join's 2,400-sample crossfade overlaps.
    const kept = pieces.reduce((n, p) => n + p.keepTo - p.keepFrom, 0) - 2_400 * (pieces.length - 1);
    assert.equal(kept, total, `${seconds} s`);
    for (const [i, p] of pieces.entries()) {
      assert.ok(p.from >= 0 && p.to <= total && p.keepFrom >= 0 && p.keepTo <= p.to - p.from + 4_800, `${seconds} s, piece ${i}`);
      if (i > 0) {
        assert.equal(p.keepFrom, 2 * rate, "a 2 s lead-in before what's kept");
        const before = pieces[i - 1]!;
        assert.equal(before.from + before.keepTo - (p.from + p.keepFrom), 2_400, "the kept parts overlap by the crossfade");
      }
    }
  }
  assert.equal(noisePieces(600 * rate).length, 5);
  assert.equal(noisePieces(125 * rate).length, 1, "a short last piece joins the one before");
});

test("reduce noise: the join filter trims, crossfades and starts the sound where the original's did", () => {
  const graph = joinGraph(noisePieces(300 * 48_000), 0.5);
  assert.equal(graph.split(";").length, 3 + 2 + 1, "three pieces, two crossfades, the start");
  assert.match(graph, /^\[1:a\]atrim=start_sample=0:end_sample=\d+,asetpts=PTS-STARTPTS\[p0\]/);
  assert.match(graph, /\[p0\]\[p1\]acrossfade=ns=2400:c1=tri:c2=tri\[j1\];\[j1\]\[p2\]acrossfade=ns=2400:c1=tri:c2=tri\[j2\]/);
  assert.ok(graph.endsWith("[j2]asetpts=PTS+0.500000/TB[sound]"));
  assert.equal(joinGraph(noisePieces(48_000), 0), "[1:a]atrim=start_sample=0:end_sample=48000,asetpts=PTS-STARTPTS[p0];[p0]asetpts=PTS+0.000000/TB[sound]");
});

test("reduce noise: what ffprobe says decides the copy's sound; no sound, no picture, too long or the wrong kind of file is unsuitable", () => {
  const probe = (over: Record<string, unknown> = {}, streams: unknown[] = [
    { codec_type: "video", disposition: { attached_pic: 0 } },
    { codec_type: "audio", channels: 1, sample_rate: "44100", bit_rate: "96000", start_time: "0.476009" },
  ]) => ({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "20.0", start_time: "0.000000", ...over }, streams });
  assert.deepEqual(soundOf(probe(), "mov"), { seconds: 20, sound: { channels: 1, sampleRate: 44_100, bitRate: 96_000, offset: 0.476009 } });
  const six = soundOf(probe({}, [{ codec_type: "video" }, { codec_type: "audio", channels: 6, sample_rate: "8" }]), "mp4").sound;
  assert.deepEqual(six, { channels: 2, sampleRate: 48_000, bitRate: null, offset: 0 }, "surround becomes stereo; an odd rate, 48 kHz");
  const unsuitable = (reason: string) => (error: unknown) => error instanceof Unsuitable && error.message === reason;
  assert.throws(() => soundOf(probe({}, [{ codec_type: "video" }]), "mp4"), unsuitable(NOISE_UNSUITABLE.noSound));
  assert.throws(() => soundOf(probe({}, [{ codec_type: "video", disposition: { attached_pic: 1 } }, { codec_type: "audio" }]), "mp4"), unsuitable(NOISE_UNSUITABLE.noPicture));
  assert.throws(() => soundOf(probe({ duration: "606" }), "mp4"), unsuitable(NOISE_UNSUITABLE.tooLong));
  assert.doesNotThrow(() => soundOf(probe({ duration: "603" }), "mp4"), "a few seconds' leeway over 10 minutes");
  assert.throws(() => soundOf(probe(), "webm"), unsuitable(NOISE_UNSUITABLE.notItsFormat), "an MP4 named .webm");
  assert.throws(() => soundOf(probe({ format_name: "avi" }), "mp4"), unsuitable(NOISE_UNSUITABLE.notItsFormat));
  assert.throws(() => soundOf(probe({ duration: "N/A" }), "mp4"), /length/);
});

test("reduce noise: the sound's WAV is capped a little over 605 s, so a longer sound (whatever its header said) always comes out too long", () => {
  const limit = 605 * 48_000; // samples: 10 minutes and the leeway
  for (const channels of [1, 2] as const) {
    const cap = soundCapBytes(channels);
    const header = 64 * 1024;
    assert.ok((cap - header) / (2 * channels) > limit + 48_000, `${channels} channel(s): room for more than the limit, so over it shows`);
    assert.ok(cap < (limit + 30 * 48_000) * 2 * channels, `${channels} channel(s): but not much more (an hour's sound would be ${3600 * 48_000 * 2 * channels} bytes)`);
  }
});

test("reduce noise: the copy's sound at about the original's bitrate and rate; Opus at 48 kHz", () => {
  const sound = { channels: 2 as const, sampleRate: 44_100, bitRate: 256_000, offset: 0 };
  assert.deepEqual(soundOptions("aac", sound), ["-c:a", "aac", "-b:a", "256k", "-ar", "44100"]);
  assert.deepEqual(soundOptions("aac", { ...sound, bitRate: 1_536_000 }).slice(2, 4), ["-b:a", "320k"], "PCM's bitrate is capped");
  assert.deepEqual(soundOptions("aac", { ...sound, bitRate: 24_000 }).slice(2, 4), ["-b:a", "64k"]);
  assert.deepEqual(soundOptions("aac", { ...sound, channels: 1, bitRate: null }).slice(2, 4), ["-b:a", "128k"], "unknown: a good default");
  assert.deepEqual(soundOptions("libopus", sound), ["-c:a", "libopus", "-b:a", "256k", "-ar", "48000"]);
});

test("recap music: a track named after one of the job's moods (its whole prefix), the same for the same job; else any; none without audio", () => {
  const names = [
    "adventure-adventure.mp3", "calm-warm-acoustic.mp3", "festive-happy-birthday.mp3", "indian-calm-saffron-sunrise.mp3",
    "indian-calm-sitar-tabla-flute.mp3", "indian-festive-wedding-celebration.mp3", "nostalgic-piano-ambient.mp3", "nostalgic-piano.mp3",
    "upbeat-happy-mandolin.mp3", "upbeat-happy-strums.mp3", "calm-notes.txt",
  ];
  const ids = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const picks = (moods: Mood[], from = names) => new Set(ids.map((id) => pickTrack(from, moods, id)));
  assert.deepEqual(picks(["festive"]), new Set(["festive-happy-birthday.mp3"]), "never indian-festive-…");
  assert.deepEqual(picks(["indian-festive"]), new Set(["indian-festive-wedding-celebration.mp3"]), "never festive-…");
  assert.deepEqual(picks(["calm"]), new Set(["calm-warm-acoustic.mp3"]), "never indian-calm-…, nor a file that isn't audio");
  assert.deepEqual(picks(["indian-calm"]), new Set(["indian-calm-saffron-sunrise.mp3", "indian-calm-sitar-tabla-flute.mp3"]));
  assert.deepEqual(picks(["adventure", "upbeat"]), new Set(["adventure-adventure.mp3", "upbeat-happy-mandolin.mp3", "upbeat-happy-strums.mp3"]), "spread over every match");
  for (const id of ids) assert.equal(pickTrack(names.toReversed(), ["adventure", "upbeat"], id), pickTrack(names, ["adventure", "upbeat"], id), "the same job, the same track");
  const noNostalgic = names.filter((n) => !n.startsWith("nostalgic-"));
  const any = picks([], noNostalgic);
  assert.ok(any.size >= 4 && !any.has("calm-notes.txt"), "no moods: any track");
  assert.deepEqual(picks(["nostalgic"], noNostalgic), any, "none of its moods there: any track");
  assert.equal(pickTrack(["calm-notes.txt"], ["calm"], ids[0]!), null, "no audio: silent");
});

test("an animation plays forward then back, 2.4–4 s, at its first photo's size (never larger than 1080p, in even pixels)", () => {
  assert.deepEqual(playOrder(3), { fps: 5, order: [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1] });
  assert.deepEqual(playOrder(4).order, [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1]);
  for (let n = 3; n <= 12; n++) {
    const { fps, order } = playOrder(n);
    assert.ok(order.length / fps >= 2.4 && order.length / fps <= 4, `${n} photos: ${order.length / fps} s`);
    assert.ok(order.every((f, i) => i === 0 || Math.abs(f - order[i - 1]!) === 1), "one step at a time, and back to the start");
    assert.equal(order.at(-1), 1);
  }
  assert.deepEqual(frameSize({ w: 1440, h: 1080 }), { w: 1440, h: 1080 });
  assert.deepEqual(frameSize({ w: 1080, h: 1440 }), { w: 1080, h: 1440 });
  assert.deepEqual(frameSize({ w: 4032, h: 3024 }), { w: 1440, h: 1080 });
  assert.deepEqual(frameSize({ w: 3024, h: 4032 }), { w: 1080, h: 1440 });
  assert.deepEqual(frameSize({ w: 4000, h: 1800 }), { w: 1920, h: 864 });
  assert.deepEqual(frameSize({ w: 1001, h: 751 }), { w: 1000, h: 750 });
});

function pgm(w: number, h: number, pixel: (x: number, y: number) => number): Uint8Array {
  const header = Buffer.from(`P5\n# made by the test\n${w} ${h}\n255\n`, "latin1");
  const body = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) body[y * w + x] = pixel(x, y);
  return Buffer.concat([header, body]);
}

test("an animation keeps only near-identical photos: shaken, brighter or darker is alike; another scene isn't", () => {
  const scene = (seed: number, dx = 0, gain = 1, offset = 0) =>
    parsePnm(pgm(16, 12, (x, y) => Math.max(0, Math.min(255, Math.round(offset + gain * (128 + 90 * Math.sin((x + dx) / (1.5 + seed)) * Math.cos(y / (1 + seed * 0.7) + seed)))))));
  const burst = [0, 0.3, 0.6, 0.4, 0.8].map((dx, i) => scene(1, dx, 1 - i * 0.05, i * 6)); // a hand's shake, the exposure drifting
  for (let i = 1; i < burst.length; i++) assert.ok(alike(burst[i - 1]!, burst[i]!), `frame ${i}`);
  // Unrelated photos: each its own pattern of light and dark (made up, but fixed).
  const other = (seed: number) => {
    let s = seed * 7919;
    return parsePnm(pgm(16, 12, () => (s = (s * 1103515245 + 12345) % 2147483648) % 256));
  };
  const unrelated = [1, 2, 3, 4].map(other);
  assert.deepEqual(burstStretch(unrelated), { start: 0, end: 1 }, "four unrelated photos: no burst");
  assert.deepEqual(burstStretch([...burst, other(5)]), { start: 0, end: 5 }, "a stray photo at the end is left out");
  assert.deepEqual(burstStretch([burst[0]!, burst[1]!, other(6), ...burst]), { start: 3, end: 8 }, "the longest stretch");
  const flat = (v: number) => parsePnm(pgm(16, 12, () => v));
  assert.ok(alike(flat(200), flat(205)), "two blank skies");
  assert.ok(!alike(flat(200), burst[0]!), "a blank frame and a detailed one");
  assert.ok(!alike(burst[0]!, parsePnm(pgm(12, 16, () => 1))), "different sizes");
});

test("quality: sharp edges score high, flat or blurred low; dark and blown out by percentiles", () => {
  const checker = measure(parsePnm(pgm(64, 64, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 230 : 30)));
  const smooth = measure(parsePnm(pgm(64, 64, (x) => 60 + x * 2)));
  assert.ok(checker.sharpness > 1000 && smooth.sharpness < 1, `${checker.sharpness} ${smooth.sharpness}`);
  const dark = measure(parsePnm(pgm(32, 32, (x, y) => (x + y) % 20)));
  assert.ok(dark.p98 < 70 && dark.brightness < 20);
  const blown = measure(parsePnm(pgm(32, 32, (x) => 240 + (x % 10))));
  assert.ok(blown.p2 > 185);
  // Colour (P6) is turned to grey by luma.
  const rgb = Buffer.concat([Buffer.from("P6\n2 2\n255\n", "latin1"), Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])]);
  assert.deepEqual([...parsePnm(rgb).pixels], [76, 150, 29, 255]);
  assert.throws(() => parsePnm(Buffer.from("P3\n1 1\n255\n0 0 0")));
});

test("a tool stopped for time says so; one killed by the system says it most likely ran out of memory", async () => {
  await assert.rejects(run("sleep", ["5"], new Deadline(10_000), 300), /took too long \(over its 0 s\)/);
  await assert.rejects(run("sh", ["-c", "kill -9 $$"], new Deadline(10_000)), /stopped by the system, most likely for running out of memory/);
  await assert.rejects(run("sh", ["-c", "echo broken >&2; exit 3"], new Deadline(10_000)), /failed \(3\): broken/);
  assert.equal((await run("sh", ["-c", "echo ok"], new Deadline(10_000))).trim(), "ok");
});

test("a pipeline hands each command's output to the next, and stops them all for time or when one fails", async () => {
  assert.equal((await pipeline([["sh", ["-c", "echo hello"]], ["tr", ["a-z", "A-Z"]]], new Deadline(10_000))).trim(), "HELLO");
  // An endless producer: stopped with its consumer, never left running or blocked on a full pipe.
  const started = Date.now();
  await assert.rejects(pipeline([["sh", ["-c", "yes"]], ["sleep", ["5"]]], new Deadline(10_000), 300), /took too long/);
  await assert.rejects(pipeline([["sh", ["-c", "yes"]], ["sh", ["-c", "head -c 10 >/dev/null; echo gave up >&2; exit 4"]]], new Deadline(10_000)), /failed \(4\): gave up/);
  await assert.rejects(pipeline([["sh", ["-c", "echo no input >&2; exit 2"]], ["cat", []]], new Deadline(10_000)), /sh failed \(2\): no input/);
  assert.ok(Date.now() - started < 4_000, "nothing waited for the endless producer");
});

test("renders are started and then asked about: 202 at once, its state until done or failed, busy meanwhile", async () => {
  const work = mkdtempSync(join(tmpdir(), "creations-server-test-"));
  const port = await freePort();
  const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "creations/src/server.ts"], {
    cwd: join(import.meta.dirname, ".."), env: { ...process.env, WORK_DIR: work, PORT: String(port), PATH: "/usr/bin:/bin" }, stdio: "pipe",
  });
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    mkdirSync(join(work, ID));
    writeFileSync(join(work, ID, "0.jpg"), "x");
    writeFileSync(join(work, ID, "1.jpg"), "x");
    const job = { id: ID, kind: "collage", photos: [{ file: "0.jpg", faces: [] }, { file: "1.jpg", faces: [] }], stamp: { local: "2026-10-20T08:59:59", offset: "+05:30", gps: null } };
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const started = await post(job);
    assert.equal(started.status, 202);
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(`http://127.0.0.1:${port}/renders/${ID}`)).json();
      if (state.state !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(state.state, "failed", "no vips on this machine: it fails, and says so");
    assert.match(state.error, /vips/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/renders/22222222-2222-4222-8222-222222222222`)).status, 404);
    assert.equal((await post({ ...job, id: "../x" })).status, 400);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { ok: true, busy: false });
  } finally {
    server.kill();
    rmSync(work, { recursive: true, force: true });
  }
});
