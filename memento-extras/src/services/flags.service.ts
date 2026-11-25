// Feature flags: on/off switches (and a few numbers) for SelfPhotos' own features, set by
// an Immich admin in Administration → Settings → Memento Features (our web patch).
//
// Stored (repositories/flags.repository.ts) as overrides on top of the defaults below. A
// setting that was never changed, or was set back to its default, keeps following the
// default, so a changed env value (e.g. the daily limit in Ansible) still applies until an
// admin overrides it.
//
// Off pauses a feature: the service refuses it and the apps hide its buttons. Nothing the
// feature already made is deleted.
//
// Each new feature adds its group here when it's built. Switches for features that don't
// exist yet would do nothing, so they aren't listed.

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
    if (!rule) continue; // a setting from an older version; ignored
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

// Applies an admin's checked changes (schemas/flags.schema.ts), all or none. A setting set
// back to its default forgets the override, so it follows the default again.
export function setFlags(updates: FlagUpdate[], adminUserId: string): FlagChange[] {
  const before = getFlags();
  const defaults = defaultFlags();
  const changes: FlagChange[] = [];
  immediately(() => {
    for (const { key, value } of updates) {
      if (read(before, key) !== value) changes.push({ key, from: read(before, key), to: value });
      // Back to the default: forget the override, so it follows the default again.
      if (read(defaults, key) === value) removeFlag(key);
      else saveFlag(key, value, adminUserId);
    }
  });
  return changes;
}
