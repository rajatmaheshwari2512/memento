// What Immich's API sends and what we keep of it (clients/immich.client.ts).

import type { ImageFile } from "./edit-provider.types.ts";

// The one header that carries the user's login, e.g. { name: "cookie", value: "immich_access_token=..." }.
export type Credential = { name: string; value: string };

export type User = { id: string; name: string; isAdmin: boolean };

// Who is asking, and the login to ask Immich with on their behalf (middleware/auth.middleware.ts).
export type Auth = { user: User; cred: Credential };

export type Asset = {
  id: string;
  type: string; // IMAGE or VIDEO
  ownerId: string;
  isTrashed: boolean;
  isLocked: boolean; // in the locked folder
  originalFileName: string;
  originalMimeType: string | null;
  fileCreatedAt: string;
  dateTimeOriginal: string | null; // UTC
  localDateTime: string | null; // the local clock time, written as if UTC (utils/photo-time.ts)
  inTimeline: boolean; // not archived, hidden or in the Locked folder
  latitude: number | null;
  longitude: number | null;
  stackPrimaryAssetId: string | null;
  width: number | null; // the original's pixel size, when Immich knows it
  height: number | null;
  shownWidth: number | null; // as shown: upright, with Immich's own crop (what an app's copy is)
  shownHeight: number | null;
  fileSize: number | null; // bytes
  durationMs: number | null; // a video's length (Immich v3 gives milliseconds); null for a photo
  isHidden: boolean; // the video half of a live photo, which Immich keeps out of sight
};

// The photo an AI edit starts from, downloaded into the edit's folder.
export type SourceImage = ImageFile & { from: "original" | "preview" };

export type Album = { id: string; albumName: string; ownerId: string };

// Immich v3 has no ownerId on albums: the owner is the album user with role "owner".
export type AlbumJson = { id: string; albumName: string; albumUsers?: Array<{ role: string; user: { id: string } }> };

export type AddResult = { id: string; success: boolean; error?: string };

export type PersonEntry = { id: string; name: string; birthDate: string | null };

// Immich's asset JSON, passed on to the apps unchanged (they show it in Immich's own grid).
export type AssetJson = { id: string; fileCreatedAt: string } & Record<string, unknown>;

export type SearchPage = { items: AssetJson[]; nextCursor: string | null };

// A file to upload into the user's library (an edit result), and what Immich answers.
export type Uploaded = { id: string; status: string };

// A new Immich API key; Immich shows the secret only once.
export type NewApiKey = { id: string; secret: string };

// Immich's searches: by meaning (smart) and by details (metadata), as we call them.
export type SmartSearch = { query: string; language: string; filter: Record<string, unknown>; size: number };
export type MetadataSearch = {
  filter: Record<string, unknown>;
  size: number;
  cursor?: string;
  withExif?: boolean;
  withPeople?: boolean; // each photo's people (named or not, hidden or not)
  orderBy?: { field: "fileCreatedAt"; direction: "asc" | "desc" };
};

// One month of the timeline (GET /api/timeline/bucket): each field a list, one entry per photo.
export type TimelineMonth = {
  id: string[];
  ownerId: string[];
  isFavorite: boolean[];
  isImage: boolean[];
  fileCreatedAt: string[];
  localOffsetHours: number[];
  city?: Array<string | null>;
  latitude?: Array<number | null>;
  longitude?: Array<number | null>;
};

// What POST /api/memories takes (an "on this day" memory, as Immich makes its own).
export type NewMemory = {
  type: "on_this_day";
  data: { year: number };
  memoryAt: string;
  showAt: string;
  hideAt: string;
  assetIds: string[];
  isSaved: false;
};
