// All settings come from environment variables. On the VM, Ansible writes them to
// /opt/memento-extras/memento-extras.env (host/roles/memento_extras). A missing required one stops the service at start.

function str(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`Missing setting: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = str(name, fallback);
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value as T;
}

// MEMENTO_SECRET: 32+ random bytes, base64. Encrypts per-user keys in the database
// (crypto-box.ts). Optional, so AI edits still run without it; live albums need it.
function secret(): Buffer | null {
  const raw = process.env.MEMENTO_SECRET;
  if (!raw) return null;
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length < 32) throw new Error("MEMENTO_SECRET must be at least 32 random bytes, base64-encoded");
  return bytes;
}

// "07:05" → minutes past midnight.
function minutesOf(name: string, value: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) throw new Error(`${name}: "${value}" isn't a time like 07:05`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function clock(name: string, fallback: string): number {
  return minutesOf(name, process.env[name] || fallback);
}

// "00:30-07:00" → minutes past midnight; "" → none.
function hours(name: string, fallback: string): { from: number; to: number } | null {
  const raw = process.env[name] ?? fallback;
  if (raw === "") return null;
  const [from, to, extra] = raw.split("-");
  if (to === undefined || extra !== undefined) throw new Error(`${name} must look like 00:30-07:00, got "${raw}"`);
  return { from: minutesOf(name, from!), to: minutesOf(name, to) };
}

export const config = {
  secret: secret(),
  // How often live albums are checked for new photos.
  liveAlbumsIntervalSeconds: int("LIVE_ALBUMS_INTERVAL_SECONDS", 300),
  maxLiveAlbumsPerUser: int("MAX_LIVE_ALBUMS_PER_USER", 20),
  // Themed memories: how often the service looks whether tonight's are due (0 = never; the
  // tests run them by hand), and a fixed "today" (YYYY-MM-DD) for the tests only.
  memoriesCheckSeconds: int("MEMORIES_CHECK_SECONDS", 300),
  // When the day's themed memories are made (config.timeZone): after the night captions' hours,
  // so their photo checks and the week's renders never run alongside the caption model.
  memoriesRunAt: clock("MEMORIES_RUN_AT", "07:05"),
  memoriesToday: process.env.MEMORIES_TODAY ?? "",
  // The creations container (creations/, its own container on a private network), the folder
  // both share for a job's files, how often the render worker looks for work (0 = never), and
  // the hours it starts nothing (the night captions' window, so two heavy jobs never overlap).
  creationsUrl: str("CREATIONS_URL", "http://memento-creations:8000").replace(/\/+$/, ""),
  creationsWorkDir: str("CREATIONS_WORK_DIR", "/work"),
  creationsCheckSeconds: int("CREATIONS_CHECK_SECONDS", 60),
  renderQuietHours: hours("RENDER_QUIET_HOURS", "00:30-07:00"),
  // Reduce noise for videos: how long a video may wait its turn (behind a creation, or the
  // morning's memories run) before it's given up, and the free space the work folder must keep
  // on top of twice the video (the original and its copy).
  reduceNoiseWaitSeconds: int("REDUCE_NOISE_WAIT_SECONDS", 45 * 60),
  reduceNoiseMinFreeBytes: int("REDUCE_NOISE_MIN_FREE_BYTES", 4 * 1024 ** 3),
  // The database copy for the backup (db/database.ts): the first one this long after start, then hourly.
  snapshotFirstSeconds: int("SNAPSHOT_FIRST_SECONDS", 60),
  port: int("PORT", 3005),
  // The trained question reader (reader/, its own container on the same network), and how long
  // Ask waits for it before searching the question as it is instead.
  readerUrl: str("READER_URL", "http://memento-reader:8000"),
  readerTimeoutMs: int("READER_TIMEOUT_MS", 1500),
  // Immich's API as seen from this container (Docker network). On a Mac for testing,
  // this can be the public URL.
  immichUrl: str("IMMICH_URL", "http://immich-server:2283").replace(/\/+$/, ""),
  dataDir: str("DATA_DIR", "/data"),
  // Adjust's save is refused when DATA_DIR has less free space than this (its uploads wait
  // there on their way to Immich: up to 20 × 100 MB at once).
  adjustMinFreeBytes: int("ADJUST_MIN_FREE_BYTES", 2 * 1024 ** 3),
  // Used to decide when "today" and "this month" start for the limits.
  timeZone: str("LIMITS_TIMEZONE", "UTC"),

  geminiApiKey: str("GEMINI_API_KEY"),
  // Google's Interactions API. Only changed for tests, to a fake that costs nothing.
  geminiUrl: str("GEMINI_URL", "https://generativelanguage.googleapis.com/v1beta/interactions"),
  geminiModel: str("GEMINI_MODEL", "gemini-nano-banana-2.1"),
  // Result size. Gemini returns a fixed size class (keeping the photo's shape), not the
  // original's pixel size: 2K is about 4 megapixels, 4K about 17.
  //   auto  4K when the original is clearly bigger than 2K (over ~5 MP, e.g. any phone
  //         photo), otherwise 2K. "Edit more" keeps the size of the edit it builds on. The
  //         admin's "Allow full quality (4K)" switch can make every edit 2K.
  imageSize: oneOf("IMAGE_SIZE", ["auto", "1K", "2K", "4K"] as const, "auto"),
  // Per edit, by size, from Google's price page for the model. Only for the log and the
  // monthly estimate shown to users; Google bills the real amount.
  costUsd: { "1K": num("COST_USD_1K", 0.0336), "2K": num("COST_USD_2K", 0.0504), "4K": num("COST_USD_4K", 0.113) },

  // Which copy of the photo goes to Gemini:
  //   auto     the original (with Immich's own crop/rotate applied), when Gemini can read
  //            it (JPEG, PNG, WebP, HEIC) and it's at most MAX_ORIGINAL_BYTES; otherwise
  //            Immich's preview (an upright JPEG, also made for RAW). Gemini applies phones'
  //            rotation tags itself (tested), so sideways-stored photos are fine.
  //   preview  always the preview (smaller and faster, but downscaled and re-compressed).
  source: oneOf("SOURCE", ["auto", "preview"] as const, "auto"),
  // Google limits a request to about 20 MB, and images are sent base64 (+33%).
  maxOriginalBytes: int("MAX_ORIGINAL_BYTES", 14 * 1024 * 1024),

  dailyLimitPerUser: int("DAILY_LIMIT_PER_USER", 20),
  monthlyLimitTotal: int("MONTHLY_LIMIT_TOTAL", 150),
  // An edit's instruction: up to 3 tools' instructions joined with the typed words (500 at most).
  maxPromptChars: int("MAX_PROMPT_CHARS", 1500),
  maxInputBytes: int("MAX_INPUT_BYTES", 20 * 1024 * 1024),
  // Unsaved results are deleted after this long.
  resultTtlMinutes: int("RESULT_TTL_MINUTES", 60),
};
