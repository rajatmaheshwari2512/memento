// Backup quality (services/backup.service.ts): the choices and the message people see.

// original: full size. saverHigh, saver: the Android app makes a smaller copy before backing up.
export const QUALITIES = ["original", "saverHigh", "saver"] as const;

export const STORAGE_SAVER_OFF = "Storage saver is switched off. An admin can turn it on in Administration → Settings → Memento Features.";
