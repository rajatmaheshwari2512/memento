// Saving edited copies (services/copies.service.ts): how many at once, and the line behind them.

export const SAVES_AT_ONCE = 20;
export const SAVES_WAITING = 50;
export const SAVE_WAIT_MS = 2 * 60_000;

export const SAVES_TOO_MANY = "Memento is saving a lot of photos right now. Try again in a minute.";
export const SAVES_TOO_LONG = "Memento was busy saving other photos for too long. Try again.";

// A photo the app made at full size and sends to be saved (Adjust's copy, or an AI edit of an area): a JPEG, or PNG for PNG originals. Capped in bytes.
export const COPY_TYPES = ["image/jpeg", "image/png"] as const;
export const MAX_COPY_BYTES = 100 * 1024 * 1024;

// Uploads waiting to be passed on to Immich (under DATA_DIR).
export const UPLOADS_FOLDER = "adjust-uploads";

export const LOW_DISK = "The server is low on disk space, so photos can't be saved right now. An admin needs to free some space.";

// A copy made before, now in the trash, that Immich wouldn't take out of it (copies.service.ts savedCopy).
export const COPY_IN_TRASH = "This copy was made before and is in the trash, and it couldn't be restored. Restore it from the trash, or empty the trash, and try again.";
