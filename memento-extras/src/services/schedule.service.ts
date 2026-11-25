// When themed memories and creations may run (FEATURES.md, sections 7–8):
//   - the day's run starts at config.memoriesRunAt (07:05: after the night captions);
//   - nothing heavy starts in RENDER_QUIET_HOURS (the night captions' hours), and a render only
//     starts if its time limit ends before them;
//   - one themed-memories run at a time for everyone (the day's pass, or someone's "make my
//     memories now"), and no render while one runs, nor from the end of the quiet hours until
//     the day's run is over: the run's photo checks use the same creations container.

import { config } from "../config.ts";
import { dayIn, minutesIn } from "../utils/local-date.ts";

export function today(): string {
  return config.memoriesToday || dayIn(new Date(), config.timeZone);
}

export function runTimeReached(now = new Date()): boolean {
  return Boolean(config.memoriesToday) || minutesIn(now, config.timeZone) >= config.memoriesRunAt;
}

export function inQuietHours(now = new Date()): boolean {
  const quiet = config.renderQuietHours;
  if (!quiet) return false;
  const m = minutesIn(now, config.timeZone);
  return quiet.from <= quiet.to ? m >= quiet.from && m < quiet.to : m >= quiet.from || m < quiet.to;
}

// Whether something allowed `ms` would finish before the quiet hours start.
export function fitsBeforeQuiet(ms: number, now = new Date()): boolean {
  const quiet = config.renderQuietHours;
  if (!quiet) return true;
  if (inQuietHours(now)) return false;
  const until = (quiet.from - minutesIn(now, config.timeZone) + 24 * 60) % (24 * 60);
  return ms <= until * 60_000;
}

let running = false;
let runDoneOn: string | null = null;

export function memoriesRunning(): boolean {
  return running;
}

// The day's run is over (or had nothing to do): renders may start.
export function markRunDone(day: string): void {
  runDoneOn = day;
}

// Whether a render may start now (fitsBeforeQuiet says whether it may start yet *and* finish).
export function rendersMayStart(now = new Date()): boolean {
  if (running || inQuietHours(now)) return false;
  const quiet = config.renderQuietHours;
  const m = minutesIn(now, config.timeZone);
  if (quiet && m >= quiet.to && m < config.memoriesRunAt) return false; // after the captions, before the day's run
  // The day's run (when it's scheduled) hasn't happened yet: it goes first.
  return config.memoriesCheckSeconds === 0 || !runTimeReached(now) || runDoneOn === today();
}

// Runs `work` unless a themed-memories run is already going (then null).
export async function withRunLock<T>(work: () => Promise<T>): Promise<T | null> {
  if (running) return null;
  running = true;
  try {
    return await work();
  } finally {
    running = false;
  }
}
