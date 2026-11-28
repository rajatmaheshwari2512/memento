// Feature flags: on/off switches (and a few numbers) for Memento's own features, set by an Immich admin in Administration → Settings → Memento Features. Stored as overrides on top of the defaults below. Off pauses a feature: the service refuses it and the apps hide its buttons.

import { config } from "../config.ts";
import { immediately } from "../db/database.ts";
import { RULES, valid } from "../schemas/flags.schema.ts";
import { removeFlag, saveFlag, storedFlags } from "./repositories/flags.repository.ts";
import type { FlagChange, Flags, FlagsAndDefaults, FlagUpdate } from "../types/flags.types.ts";

export function defaultFlags(): Flags {
  return {
    gemini: {
      enabled: true,
      tools: true,
      allow4k: true,
      dailyLimitPerUser: config.dailyLimitPerUser,
      monthlyLimitTotal: config.monthlyLimitTotal,
    },
    themedMemories: { enabled: true },
    creations: { enabled: true },
    liveAlbums: { enabled: true },
    askPhotos: { enabled: true, trainedReader: true, places: true },
    captions: { enabled: true },
    adjust: { enabled: true },
    reduceNoise: { enabled: true },
    storageSaver: { enabled: false },
  };
}

function read(flags: Flags, key: string): unknown {
  const [group, name] = key.split(".") as [string, string];
  return (flags as unknown as Record<string, Record<string, unknown>>)[group]![name];
}

function write(flags: Flags, key: string, value: unknown): void {
  const [group, name] = key.split(".") as [string, string];
  (flags as unknown as Record<string, Record<string, unknown>>)[group]![name] = value;
}

// The flags in force: defaults, plus any stored overrides that are still valid.
export function getFlags(): Flags {
  const flags = defaultFlags();
  for (const row of storedFlags()) {
    const rule = RULES[row.key];
    if (!rule) continue;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (valid(rule, value)) write(flags, row.key, value);
  }
  return flags;
}

// What GET /flags answers: the flags in force, and their defaults.
export function flagsAndDefaults(): FlagsAndDefaults {
  return { flags: getFlags(), defaults: defaultFlags() };
}

// Applies an admin's checked changes (schemas/flags.schema.ts), all or none.
export function setFlags(updates: FlagUpdate[], adminUserId: string): FlagChange[] {
  const before = getFlags();
  const defaults = defaultFlags();
  const changes: FlagChange[] = [];
  immediately(() => {
    for (const { key, value } of updates) {
      if (read(before, key) !== value) changes.push({ key, from: read(before, key), to: value });
      if (read(defaults, key) === value) removeFlag(key);
      else saveFlag(key, value, adminUserId);
    }
  });
  return changes;
}
