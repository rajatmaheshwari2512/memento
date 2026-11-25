// Saving edited copies (services/copies.service.ts): how many at once, and the line behind them.
// A save holds only a few MB of memory (an upload streams to disk and on to Immich; an AI edit
// is a few MB), so the limit isn't about memory: 20 at once is a guard against a bug or abuse
// that normal use never reaches. Beyond it, saves wait their turn (the apps just show
// "Saving…" longer); the line is capped too, so it can't grow without bound. Disk is guarded
// separately (config.adjustMinFreeBytes: 20 uploads of up to 100 MB can wait on disk).

export const SAVES_AT_ONCE = 20;
export const SAVES_WAITING = 50;
export const SAVE_WAIT_MS = 2 * 60_000;

export const SAVES_TOO_MANY = "Memento is saving a lot of photos right now. Try again in a minute.";
export const SAVES_TOO_LONG = "Memento was busy saving other photos for too long. Try again.";

// A photo the app made at full size and sends to be saved: Adjust's copy, or an AI edit of a
// highlighted area pasted onto the original. A JPEG (or PNG, for PNG originals); a 50 MP
// JPEG is about 25 MB. It goes to a file and from there to Immich, never whole into memory;
// the cap bounds the disk.
export const COPY_TYPES = ["image/jpeg", "image/png"] as const;
export const MAX_COPY_BYTES = 100 * 1024 * 1024;

// Uploads waiting to be passed on to Immich (under DATA_DIR), each removed when its save ends.
// The name is from when only Adjust used it.
export const UPLOADS_FOLDER = "adjust-uploads";

export const LOW_DISK = "The server is low on disk space, so photos can't be saved right now. An admin needs to free some space.";

// A copy made before, now in the trash, that Immich wouldn't take out of it (copies.service.ts savedCopy).
export const COPY_IN_TRASH = "This copy was made before and is in the trash, and it couldn't be restored. Restore it from the trash, or empty the trash, and try again.";
