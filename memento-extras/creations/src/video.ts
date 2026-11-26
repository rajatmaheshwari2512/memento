// What every video Memento makes shares (recaps, animations, cinematic photos): H.264 that every
// phone and browser plays, TV-range BT.709 colour, and its date and place inside the file, where
// phones put them.

import { rm } from "node:fs/promises";
import type { Stamp } from "./exif.ts";
import type { Size } from "./layout.ts";
import { type Deadline, run } from "./run.ts";
import { sizeOf } from "./vips.ts";

// The biggest a video made from photos is, either way up.
export const VIDEO_MAX = { long: 1920, short: 1080 };

// A video's frame for a photo of this size: scaled down (never up) to fit VIDEO_MAX, in even
// pixels (H.264).
export function frameSize(photo: Size): Size {
  const landscape = photo.w >= photo.h;
  const scale = Math.min(1, (landscape ? VIDEO_MAX.long : VIDEO_MAX.short) / photo.w, (landscape ? VIDEO_MAX.short : VIDEO_MAX.long) / photo.h);
  const even = (v: number) => Math.max(2, Math.floor((v * scale) / 2) * 2);
  return { w: even(photo.w), h: even(photo.h) };
}

// `photo` upright and no bigger than VIDEO_MAX either way, as `out` (a TIFF); returns the frame
// size a video of it takes (frameSize).
export async function fitPhoto(photo: string, out: string, deadline: Deadline): Promise<Size> {
  const box = String(VIDEO_MAX.long);
  await run("vips", ["thumbnail", photo, out, box, "--height", box, "--size", "down"], deadline);
  return frameSize(await sizeOf(out, deadline));
}

// `photo` upright and cropped to fill `size` (from its middle), as `out` (a TIFF) in 8-bit sRGB
// colour, whatever it was (a black-and-white photo becomes three equal colours).
export async function framePhoto(photo: string, size: Size, out: string, deadline: Deadline): Promise<void> {
  const fitted = `${out}.fit.tif`;
  await run("vips", ["thumbnail", photo, fitted, String(size.w), "--height", String(size.h), "--crop", "centre"], deadline);
  await run("vips", ["colourspace", fitted, out, "srgb"], deadline);
  await rm(fitted, { force: true });
}

// 1080p-or-smaller H.264 High, 8-bit 4:2:0, TV-range BT.709, at a modest bitrate, two threads.
export function h264(fps: number, maxrate = "6M"): string[] {
  return [
    "-an", "-c:v", "libx264", "-preset", "faster", "-crf", "23", "-maxrate", maxrate, "-bufsize", "12M", "-profile:v", "high", "-level", "4.1",
    "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-r", String(fps), "-g", String(fps * 2), "-video_track_timescale", String(fps * 512), "-threads", "2",
  ];
}

export const TO_TV = "scale=out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";

// "+15.4989+073.8278/" (ISO 6709), as phones write it in videos.
function iso6709(lat: number, lon: number): string {
  const f = (v: number, width: number) => `${v < 0 ? "-" : "+"}${Math.abs(v).toFixed(4).padStart(width, "0")}`;
  return `${f(lat, 7)}${f(lon, 8)}/`;
}

// ffmpeg's output options for an MP4 that starts playing at once and carries its date and place
// as phones write them (Immich reads them), capped at `maxBytes`.
export function mp4Output(stamp: Stamp, maxBytes: number): string[] {
  const { local, offset, gps } = stamp;
  return [
    "-movflags", "+faststart+use_metadata_tags", "-fs", String(maxBytes),
    "-metadata", `creation_time=${new Date(Date.parse(`${local}${offset}`)).toISOString()}`,
    "-metadata", `com.apple.quicktime.creationdate=${local}${offset}`,
    ...(gps ? ["-metadata", `com.apple.quicktime.location.ISO6709=${iso6709(gps.lat, gps.lon)}`] : []),
    "-metadata", "com.apple.quicktime.software=Memento",
  ];
}
