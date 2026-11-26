// SelfPhotos backup quality: calls to Memento's extras service (memento-extras) at /extras.

import { request } from '#lib/ai-edit/ai-edit-api.ts';

// The person's own choice for backups from Memento's Android app.
export type BackupQuality = 'original' | 'saverHigh' | 'saver';
export type BackupSettings = { quality: BackupQuality };

export const getBackupSettings = () => request<BackupSettings>('GET', '/backup/settings');

export const updateBackupSettings = (settings: BackupSettings) =>
  request<BackupSettings>('PUT', '/backup/settings', settings);
