// Every setting an admin may change, its allowed values, and how it's shown.

import { GEMINI_SECTION } from "../constants/flags.constants.ts";
import type { FlagUpdate, Rule, Setting } from "../types/flags.types.ts";
import { HttpError } from "../utils/http-error.ts";

// Every setting an admin may change, as "group.name". Anything else is refused.
export const RULES: Record<string, Rule> = {
  "gemini.enabled": {
    kind: "boolean", section: GEMINI_SECTION, title: "Enable Gemini AI edits",
    subtitle: "Off hides the AI Edit button on the web and in the app, and the server refuses AI edits. Saved edits stay.",
  },
  "gemini.tools": {
    kind: "boolean", section: GEMINI_SECTION, title: "Enable AI tools: presets and highlighting",
    subtitle: "Preset edits in the photo editor (Unblur, Enhance, Better sky, styles and more; up to 3 in one edit), and brushing over an area to edit just that area; only the brushed area is pasted onto the original. Each costs like any AI edit. Off hides them, and the server refuses highlighted edits. Typed instructions still work while AI edits are on.",
  },
  "gemini.allow4k": {
    kind: "boolean", section: GEMINI_SECTION, title: "Allow full quality (4K)",
    subtitle: "Phone photos are edited at 4K (about ₹12 an edit). Off: every edit is 2K, about 4 megapixels (about ₹5).",
  },
  "gemini.dailyLimitPerUser": {
    kind: "int", min: 0, max: 1000, section: GEMINI_SECTION, title: "AI edits per person per day",
    subtitle: "Resets at midnight. Everyone's default; Memento admin can set a different one for a person.",
  },
  "gemini.monthlyLimitTotal": {
    kind: "int", min: 0, max: 10000, section: GEMINI_SECTION, title: "AI edits per month, everyone together",
    subtitle: "A cap on the monthly Gemini bill. The prepaid Google balance is the hard stop.",
  },
  "liveAlbums.enabled": {
    kind: "boolean", section: "Live Albums", title: "Enable live albums",
    subtitle: "Off hides the Live albums page, stops the checks and refuses changes. Live albums stay, as normal albums with all their photos.",
  },
  "askPhotos.enabled": {
    kind: "boolean", section: "Ask Photos", title: "Enable Ask Photos",
    subtitle: "Off hides the Ask search type and the server refuses questions. Captions stay. Nothing leaves our servers either way.",
  },
  "askPhotos.trainedReader": {
    kind: "boolean", section: "Ask Photos", title: "Read questions with the trained model",
    subtitle: "A small model trained on Hinglish and English reads each question: people, dates, places, newest or oldest, videos, favourites. Off, or if the model is slow or down, the question goes to Immich's search as it is, without those. It runs on our server.",
  },
  "askPhotos.places": {
    kind: "boolean", section: "Ask Photos", title: "Understand places",
    subtitle: "\"Last time in Goa\" puts photos taken in Goa first, then everything else that matches. Needs the trained model (it spots which words say where), and uses the places Immich found in each person's own photos (only photos with a location have one).",
  },
  "themedMemories.enabled": {
    kind: "boolean", section: "Memories", title: "Make themed memories",
    subtitle: "Each morning after the night captions, for people who turned them on: Spotlight on a person (at most once a week), Best of last month (on the 1st), trips once they end (needs photos with a location) and big days. They show with Immich's own memories in every app; Memento's apps also show their titles. Off stops new ones; memories already made stay.",
  },
  "creations.enabled": {
    kind: "boolean", section: "Memories", title: "Make collages, recap videos, animations and cinematic photos",
    subtitle: "At most one collage, one short video, one animation (a burst of near-identical shots played as a loop) and one cinematic photo (a photo turned into a short 3D camera move) a week per person, from that week's best themed memory, shown together in a memory of their own from Sunday to Tuesday. Made on our server at the lowest priority (never during night captions), and saved into the person's library as normal photos and videos, in albums called Collages, Recaps, Animations and Cinematic. Each person can turn them off for themselves, and delete any like a photo. Off stops new ones; existing ones stay.",
  },
  "captions.enabled": {
    kind: "boolean", section: "Captions for new photos", title: "Caption new photos at night",
    subtitle: "Runs at night at the lowest priority, so Memento and Ask always go first. Off stops it; existing captions stay. Photos never leave our servers.",
  },
  "adjust.enabled": {
    kind: "boolean", section: "Editing", title: "Enable Adjust: sliders, filters and straighten",
    subtitle: "Light and colour sliders, filters and straighten in the photo editor, saved as a copy stacked on the original. Off hides Adjust on the web and in the app, and the server refuses to save. Saved copies stay. Free: it runs on your own device.",
  },
  "reduceNoise.enabled": {
    kind: "boolean", section: "Videos", title: "Reduce noise for videos",
    subtitle: "A Reduce noise button on your own videos: our server cleans up the sound (wind, traffic, hum) with DeepFilterNet, a small open model that works best on speech, and saves a copy stacked on the original. The picture isn't changed. Videos up to 10 minutes and 2 GB, one at a time, not at night while photos are captioned. Free: nothing leaves our server. Off hides the button and the server refuses. Cleaned copies stay.",
  },
  "storageSaver.enabled": {
    kind: "boolean", section: "Backup", title: "Enable Storage saver",
    subtitle: "Lets each person choose smaller backups from Memento's phone app: Storage saver (videos at 1080p, about 4 Mbps) or Storage saver, high (videos at 2K, about 8 Mbps); ordinary photos over 16 MP become 16 MP. HDR, motion and portrait photos stay full size, and so do HDR videos from Android phones; iPhone HDR videos are shrunk and stay HDR. Website uploads always stay full size. Off: backups are full size again from the next upload; copies already made stay as they are.",
  },
};

// The settings an admin may change, in display order, with their labels and limits.
export function settingsList(): Setting[] {
  return Object.entries(RULES).map(([key, rule]) => ({ key, ...rule }));
}

export function valid(rule: Rule, value: unknown): boolean {
  if (rule.kind === "boolean") return typeof value === "boolean";
  return typeof value === "number" && Number.isInteger(value) && value >= rule.min && value <= rule.max;
}

// Whether `value` is allowed for the setting `key`.
export function validSetting(key: string, value: unknown): boolean {
  const rule = RULES[key];
  return rule !== undefined && valid(rule, value);
}

// An admin's changes, e.g. { gemini: { enabled: false } }: every setting known and every value in range, or nothing is changed.
export function parseFlagChanges(patch: Record<string, unknown>): FlagUpdate[] {
  const updates: FlagUpdate[] = [];
  for (const [group, values] of Object.entries(patch)) {
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      throw new HttpError(400, `Unknown setting: ${group}.`);
    }
    for (const [name, value] of Object.entries(values)) {
      const key = `${group}.${name}`;
      const rule = RULES[key];
      if (!rule) throw new HttpError(400, `Unknown setting: ${key}.`);
      if (!valid(rule, value)) {
        throw new HttpError(
          400,
          rule.kind === "boolean" ? `${key} must be on or off.` : `${key} must be a whole number from ${rule.min} to ${rule.max}.`,
        );
      }
      updates.push({ key, value });
    }
  }
  return updates;
}
