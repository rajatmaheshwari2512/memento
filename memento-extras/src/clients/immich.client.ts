// Calls Immich's API as the calling user, with that user's own login.

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { type FileHandle, open, rm } from "node:fs/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { config } from "../config.ts";
import { GEMINI_INPUT_TYPES } from "../constants/edits.constants.ts";
import type { PlaceFound, PlaceKind } from "../types/ask.types.ts";
import type {
  AddResult, Album, AlbumJson, Asset, AssetJson, Credential, MetadataSearch, NewApiKey, NewMemory, PersonEntry, SearchPage, SmartSearch,
  SourceImage, TimelineMonth, Uploaded, User,
} from "../types/immich.types.ts";
import { HttpError } from "../utils/http-error.ts";
import { sniffImage } from "../utils/image-type.ts";
import { localDateWithOffset } from "../utils/photo-time.ts";

async function call(
  cred: Credential, method: string, path: string, body?: { json: unknown } | { form: FormData }, timeoutMs = 60_000,
): Promise<Response> {
  const headers: Record<string, string> = { [cred.name]: cred.value, accept: "application/json" };
  let payload: string | FormData | undefined;
  if (body && "json" in body) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body.json);
  } else if (body) {
    payload = body.form;
  }
  let res: Response;
  try {
    res = await fetch(config.immichUrl + path, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.error(JSON.stringify({ event: "immich_unreachable", path: path.split("?")[0], error: String(error) }));
    throw new ImmichUnreachable(502, "Couldn't reach Immich. Try again in a moment.");
  }
  if (cred.name === "x-api-key" && (res.status === 401 || res.status === 403)) {
    await res.body?.cancel();
    throw new KeyRejected();
  }
  return res;
}

// Immich didn't answer (down, restarting, or too slow).
export class ImmichUnreachable extends HttpError {}

// Thrown when Immich refuses a stored key.
export class KeyRejected extends Error {}

// Logs Immich's answer and throws a message the user can read (`message`, when given, with
// Immich's status).
async function failed(res: Response, what: string, message?: string): Promise<never> {
  const text = (await res.text()).slice(0, 300);
  console.error(JSON.stringify({ event: "immich_error", what, status: res.status, body: text }));
  if (message) throw new HttpError(res.status, message);
  if (res.status === 401) throw new HttpError(401, "Your Immich login has expired. Log in again.");
  if (res.status === 403) throw new HttpError(403, "Immich didn't allow this.");
  throw new HttpError(502, `Immich returned an error while trying to ${what}.`);
}

export async function whoAmI(cred: Credential): Promise<User | null> {
  const res = await call(cred, "GET", "/api/users/me");
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) await failed(res, "check your login");
  const me = (await res.json()) as { id: string; name: string; isAdmin: boolean };
  return { id: me.id, name: me.name, isAdmin: me.isAdmin };
}

export async function getAsset(cred: Credential, id: string): Promise<Asset> {
  const res = await call(cred, "GET", `/api/assets/${encodeURIComponent(id)}`);
  if (res.status === 400 || res.status === 404) throw new HttpError(404, "Photo not found.");
  if (!res.ok) await failed(res, "read the photo's details");
  const a = (await res.json()) as {
    id: string; type: string; ownerId: string; isTrashed: boolean; originalFileName: string;
    originalMimeType?: string; fileCreatedAt: string; localDateTime?: string; visibility?: string;
    width?: number | null; height?: number | null; duration?: number | string | null;
    exifInfo?: {
      dateTimeOriginal?: string | null; latitude?: number | null; longitude?: number | null;
      exifImageWidth?: number | null; exifImageHeight?: number | null; fileSizeInByte?: number | null;
    };
    stack?: { primaryAssetId: string } | null;
  };
  return {
    id: a.id,
    type: a.type,
    ownerId: a.ownerId,
    isTrashed: a.isTrashed,
    isLocked: a.visibility === "locked",
    inTimeline: a.visibility === undefined || a.visibility === "timeline",
    originalFileName: a.originalFileName,
    originalMimeType: a.originalMimeType ?? null,
    fileCreatedAt: a.fileCreatedAt,
    dateTimeOriginal: a.exifInfo?.dateTimeOriginal ?? null,
    localDateTime: a.localDateTime ?? null,
    latitude: a.exifInfo?.latitude ?? null,
    longitude: a.exifInfo?.longitude ?? null,
    stackPrimaryAssetId: a.stack?.primaryAssetId ?? null,
    width: a.exifInfo?.exifImageWidth ?? null,
    height: a.exifInfo?.exifImageHeight ?? null,
    shownWidth: a.width ?? null,
    shownHeight: a.height ?? null,
    fileSize: a.exifInfo?.fileSizeInByte ?? null,
    durationMs: typeof a.duration === "number" && Number.isFinite(a.duration) ? a.duration : null,
    isHidden: a.visibility === "hidden",
  };
}

// Downloads the image that goes to Gemini into the edit's folder. `edited=true` applies the user's crop/rotate; the original is preferred, the preview is the fallback.
export async function getSourceImage(cred: Credential, asset: Asset, folder: string): Promise<SourceImage> {
  if (config.source === "auto" && (asset.fileSize ?? 0) <= config.maxOriginalBytes) {
    const original = await tryOriginal(cred, asset, join(folder, "original"));
    if (original) return original;
  }
  const res = await call(cred, "GET", `/api/assets/${encodeURIComponent(asset.id)}/thumbnail?size=preview&edited=true`);
  if (!res.ok) await failed(res, "download the photo");
  const path = join(folder, "preview");
  const bytes = await saveBody(res, path, config.maxInputBytes, tooLargeToEdit);
  const mime = sniffImage(await fileHead(path));
  if (!mime) throw new HttpError(415, "This photo's format can't be edited.");
  return { path, mime, bytes, from: "preview" };
}

const tooLargeToEdit = () => new HttpError(413, "This photo is too large to edit.");

// The original, or null if Gemini can't take it (RAW and other formats, or too large).
async function tryOriginal(cred: Credential, asset: Asset, path: string): Promise<SourceImage | null> {
  const res = await call(cred, "GET", `/api/assets/${encodeURIComponent(asset.id)}/original?edited=true`);
  if (!res.ok) await failed(res, "download the photo");
  const declared = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let bytes: number;
  try {
    bytes = await saveBody(res, path, config.maxOriginalBytes, tooLargeToEdit);
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) {
      await rm(path, { force: true });
      return null;
    }
    throw error;
  }
  const mime = sniffImage(await fileHead(path)) ?? (declared === "image/heic" || declared === "image/heif" ? declared : null);
  if (!mime || !GEMINI_INPUT_TYPES.has(mime)) {
    await rm(path, { force: true });
    return null;
  }
  return { path, mime, bytes, from: "original" };
}

// Streams a response's body into a new file at `file` (never onto something already there),
// refused (`tooLarge`) when it's declared or found to be over `maxBytes`. Returns its size.
async function saveBody(res: Response, file: string, maxBytes: number, tooLarge: () => Error): Promise<number> {
  if (Number(res.headers.get("content-length") ?? "0") > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > maxBytes ? tooLarge() : null, chunk);
    },
  });
  const body = res.body ? Readable.fromWeb(res.body as NodeReadableStream) : Readable.from([]);
  await pipeline(body, limit, createWriteStream(file, { flags: "wx", mode: 0o600 }));
  return size;
}

async function fileHead(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

// A new photo or video of the calling user from `data` (bytes, or a file on disk).
export async function uploadBlob(cred: Credential, data: Blob, filename: string, fileCreatedAt: string, what: string, timeoutMs?: number): Promise<Uploaded> {
  const form = new FormData();
  form.set("assetData", data, filename);
  form.set("filename", filename);
  form.set("fileCreatedAt", fileCreatedAt);
  form.set("fileModifiedAt", new Date().toISOString());
  const res = await call(cred, "POST", "/api/assets", { form }, timeoutMs);
  if (!res.ok) await failed(res, what);
  return (await res.json()) as { id: string; status: string };
}

// The same for a big file on disk, streamed. `file` is an open file and the size it had when checked: exactly that much is sent.
export async function uploadFile(
  cred: Credential, file: { handle: FileHandle; size: number }, mime: string, filename: string, fileCreatedAt: string, what: string, timeoutMs: number,
): Promise<Uploaded> {
  const boundary = `----MementoBoundary${randomUUID().replace(/-/g, "")}`;
  const escaped = filename.replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22");
  const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = Buffer.from(
    field("filename", escaped) + field("fileCreatedAt", fileCreatedAt) + field("fileModifiedAt", new Date().toISOString()) +
      `--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="${escaped}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  async function* body() {
    yield head;
    let read = 0;
    for await (const chunk of file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false })) {
      read += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (read !== file.size) throw new Error("the file changed while it was uploaded");
    yield tail;
  }
  const url = new URL(`${config.immichUrl}/api/assets`);
  const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method: "POST",
    headers: {
      [cred.name]: cred.value, accept: "application/json",
      "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(head.length + file.size + tail.length),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  req.on("error", () => {});
  const answered = new Promise<IncomingMessage>((resolve, reject) => req.once("response", resolve).once("error", reject));
  const sent = pipeline(Readable.from(body()), req).catch((error: unknown) => error);
  const stop = async () => {
    req.destroy();
    await sent;
  };
  let answer: IncomingMessage;
  try {
    answer = await answered;
  } catch (error) {
    await stop();
    console.error(JSON.stringify({ event: "immich_unreachable", path: "/api/assets", error: String(error) }));
    throw new ImmichUnreachable(502, "Couldn't reach Immich. Try again in a moment.");
  }
  const status = answer.statusCode ?? 502;
  const res = new Response(status === 204 ? null : (Readable.toWeb(answer) as ReadableStream<Uint8Array>), { status });
  if (!res.ok) {
    try {
      if (cred.name === "x-api-key" && (status === 401 || status === 403)) {
        await res.body?.cancel();
        throw new KeyRejected();
      }
      return await failed(res, what);
    } finally {
      await stop();
    }
  }
  await sent;
  return (await res.json()) as Uploaded;
}

// Takes assets out of the trash (Immich's own restore). False if Immich refused.
export async function restoreFromTrash(cred: Credential, ids: string[]): Promise<boolean> {
  const res = await call(cred, "POST", "/api/trash/restore/assets", { json: { ids } });
  if (!res.ok) {
    console.error(JSON.stringify({ event: "immich_error", what: "restore from the trash", status: res.status, body: (await res.text()).slice(0, 300) }));
    return false;
  }
  await res.body?.cancel();
  return true;
}

// Copies the original's date, time zone and place onto an edited copy.
export async function copyDateAndPlace(cred: Credential, id: string, from: Asset): Promise<void> {
  const date = from.dateTimeOriginal === null ? from.fileCreatedAt : localDateWithOffset(from.dateTimeOriginal, from.localDateTime);
  const update: Record<string, unknown> = { dateTimeOriginal: date };
  if (from.latitude !== null && from.longitude !== null) {
    update.latitude = from.latitude;
    update.longitude = from.longitude;
  }
  const res = await call(cred, "PUT", `/api/assets/${encodeURIComponent(id)}`, { json: update });
  if (!res.ok) await failed(res, "copy the date and place");
}

// Stacks the edit on top of the original.
export async function stackOnTop(cred: Credential, editId: string, original: Asset): Promise<void> {
  const other = original.stackPrimaryAssetId ?? original.id;
  if (other === editId) return;
  const res = await call(cred, "POST", "/api/stacks", { json: { assetIds: [editId, other] } });
  if (!res.ok) await failed(res, "stack the edit with the original");
}

// An Immich API key for the user whose login is `cred`. `what` names its use in the message shown if Immich refuses.
export async function createApiKey(cred: Credential, name: string, permissions: string[], what = "live albums"): Promise<NewApiKey> {
  const res = await call(cred, "POST", "/api/api-keys", { json: { name, permissions } });
  if (!res.ok) await failed(res, `create a key for ${what}`);
  const body = (await res.json()) as { id: string; secret: string };
  return { id: body.id, secret: body.secret };
}

export async function deleteApiKey(cred: Credential, id: string, what = "live albums"): Promise<void> {
  const res = await call(cred, "DELETE", `/api/api-keys/${encodeURIComponent(id)}`);
  if (!res.ok && res.status !== 400 && res.status !== 404) await failed(res, `delete the ${what} key`);
}

function toAlbum(a: AlbumJson): Album {
  return { id: a.id, albumName: a.albumName, ownerId: a.albumUsers?.find((u) => u.role === "owner")?.user.id ?? "" };
}

export async function createAlbum(cred: Credential, albumName: string): Promise<Album> {
  const res = await call(cred, "POST", "/api/albums", { json: { albumName } });
  if (!res.ok) await failed(res, "create the album");
  return toAlbum((await res.json()) as AlbumJson);
}

// null when the album doesn't exist or this login can't see it.
export async function getAlbum(cred: Credential, id: string): Promise<Album | null> {
  const res = await call(cred, "GET", `/api/albums/${encodeURIComponent(id)}?withoutAssets=true`);
  if (res.status === 400 || res.status === 403 || res.status === 404) return null;
  if (!res.ok) await failed(res, "read the album");
  return toAlbum((await res.json()) as AlbumJson);
}

// True when this login can see the person (i.e. it's one of the user's people).
export async function personExists(cred: Credential, id: string): Promise<boolean> {
  const res = await call(cred, "GET", `/api/people/${encodeURIComponent(id)}`);
  if (res.status === 400 || res.status === 403 || res.status === 404) return false;
  if (!res.ok) await failed(res, "check a person");
  return true;
}

export async function addToAlbum(cred: Credential, albumId: string, ids: string[]): Promise<AddResult[]> {
  const res = await call(cred, "PUT", `/api/albums/${encodeURIComponent(albumId)}/assets`, { json: { ids } });
  if (!res.ok) await failed(res, "add photos to the album");
  return (await res.json()) as AddResult[];
}

// --- Ask Photos (services/ask.service.ts) ---

// The user's people (not hidden ones), in Immich's order.
export async function listPeople(cred: Credential): Promise<PersonEntry[]> {
  const people: PersonEntry[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await call(cred, "GET", `/api/people?withHidden=false&size=1000&page=${page}`);
    if (!res.ok) await failed(res, "read your people");
    const body = (await res.json()) as { people: Array<{ id: string; name?: string; birthDate?: string | null }>; hasNextPage?: boolean };
    for (const p of body.people) people.push({ id: p.id, name: p.name ?? "", birthDate: p.birthDate ?? null });
    if (!body.hasNextPage) break;
  }
  return people;
}

// The cities, states or countries in the user's photos, as Immich names them.
export async function placeNames(cred: Credential, kind: PlaceKind): Promise<string[]> {
  const res = await call(cred, "GET", `/api/search/suggestions?type=${kind}&includeNull=false`);
  if (!res.ok) await failed(res, "read your places");
  return ((await res.json()) as Array<string | null>).filter((name): name is string => typeof name === "string" && name.trim() !== "");
}

// Places worldwide matching a name, other name or close spelling, best first (up to 20). Given up after `timeoutMs`.
export async function searchPlaces(cred: Credential, name: string, timeoutMs: number): Promise<PlaceFound[]> {
  const res = await call(cred, "GET", `/api/search/places?name=${encodeURIComponent(name)}`, undefined, timeoutMs);
  if (!res.ok) await failed(res, "look up a place");
  return (await res.json()) as PlaceFound[];
}

// Immich v3's search with a `filter` object. Smart search returns best first, with no further pages. `withExif` adds the details the apps' photo grid shows.
export async function searchSmart(cred: Credential, body: SmartSearch): Promise<AssetJson[]> {
  const res = await call(cred, "POST", "/api/search/smart", { json: { ...body, withExif: true } });
  if (!res.ok) await failed(res, "search for photos");
  return ((await res.json()) as { assets: { items: AssetJson[] } }).assets.items;
}

// Ranked by date, newest first (or as `orderBy` says), one page at a time.
export async function searchMetadata(
  cred: Credential,
  body: MetadataSearch,
): Promise<SearchPage> {
  const res = await call(cred, "POST", "/api/search/metadata", { json: body });
  if (res.status === 400 && body.cursor) await failed(res, "search for photos", "These results have changed. Search again.");
  if (!res.ok) await failed(res, "search for photos");
  const out = (await res.json()) as { assets: { items: AssetJson[]; nextCursor?: string | null } };
  return { items: out.assets.items, nextCursor: out.assets.nextCursor ?? null };
}

// Thrown when Immich answered with an error (the request was refused).
export class ImmichRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Immich refused (${status})`);
    this.status = status;
  }
}

// Months with photos in the user's own timeline. With `personId`, that person's photos only.
export async function timelineMonths(cred: Credential, personId?: string): Promise<Array<{ month: string; count: number }>> {
  const query = new URLSearchParams({ visibility: "timeline", withStacked: "true", ...(personId ? { personId } : {}) });
  const res = await call(cred, "GET", `/api/timeline/buckets?${query}`);
  if (!res.ok) await failed(res, "read your timeline");
  const body = (await res.json()) as Array<{ timeBucket: string; count: number }>;
  return body.map((b) => ({ month: b.timeBucket.slice(0, 7), count: b.count }));
}

// One month of the user's own timeline, compactly. With `personId`, that person's photos only.
export async function timelineMonth(cred: Credential, month: string, personId?: string): Promise<TimelineMonth> {
  const query = new URLSearchParams({
    timeBucket: `${month}-01T00:00:00.000Z`, visibility: "timeline", withStacked: "true", withCoordinates: "true", ...(personId ? { personId } : {}),
  });
  const res = await call(cred, "GET", `/api/timeline/bucket?${query}`);
  if (!res.ok) await failed(res, "read your timeline");
  return (await res.json()) as TimelineMonth;
}

// Every photo matching a search, following the cursor, up to `maxPages` of 1,000. `keep` turns each page into what the caller keeps (null drops it).
export async function searchAll<T>(
  cred: Credential, body: Omit<MetadataSearch, "size" | "cursor">, maxPages: number, keep: (asset: AssetJson) => T | null,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const found = await searchMetadata(cred, { ...body, size: 1000, ...(cursor ? { cursor } : {}) });
    for (const asset of found.items) {
      const kept = keep(asset);
      if (kept !== null) out.push(kept);
    }
    if (!found.nextCursor) break;
    cursor = found.nextCursor;
  }
  return out;
}

// Creates a memory. Throws ImmichRefused if Immich answers with an error.
export async function createMemory(cred: Credential, body: NewMemory): Promise<{ id: string; assets: number }> {
  const res = await call(cred, "POST", "/api/memories", { json: body });
  if (!res.ok) {
    console.error(JSON.stringify({ event: "immich_error", what: "create a memory", status: res.status, body: (await res.text()).slice(0, 300) }));
    throw new ImmichRefused(res.status);
  }
  const memory = (await res.json()) as { id: string; assets?: unknown[] };
  return { id: memory.id, assets: memory.assets?.length ?? 0 };
}

// Streams an Immich file (a preview, thumbnail or playback copy) to `file`, stopping at `maxBytes`.
export async function downloadTo(cred: Credential, path: string, file: string, maxBytes: number, timeoutMs = 120_000): Promise<number> {
  const res = await call(cred, "GET", path, undefined, timeoutMs);
  if (!res.ok) await failed(res, "download a photo");
  if (!res.body) throw new HttpError(413, "Too large to use.");
  return saveBody(res, file, maxBytes, () => new HttpError(413, "Too large to use."));
}

// Where faces are in a photo, as fractions of its size.
export async function facesOf(cred: Credential, assetId: string): Promise<Array<[number, number, number, number]>> {
  const res = await call(cred, "GET", `/api/faces?id=${encodeURIComponent(assetId)}`);
  if (!res.ok) await failed(res, "read a photo's faces");
  const faces = (await res.json()) as Array<{ imageWidth: number; imageHeight: number; boundingBoxX1: number; boundingBoxY1: number; boundingBoxX2: number; boundingBoxY2: number }>;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return faces
    .filter((f) => f.imageWidth > 0 && f.imageHeight > 0)
    .map((f) => [clamp(f.boundingBoxX1 / f.imageWidth), clamp(f.boundingBoxY1 / f.imageHeight), clamp(f.boundingBoxX2 / f.imageWidth), clamp(f.boundingBoxY2 / f.imageHeight)] as [number, number, number, number])
    .filter(([x1, y1, x2, y2]) => x1 < x2 && y1 < y2);
}

// Tags photos with a tag of this name ("Memento/Creations"), made if it doesn't exist.
export async function tagAssets(cred: Credential, tag: string, ids: string[]): Promise<void> {
  const upsert = await call(cred, "PUT", "/api/tags", { json: { tags: [tag] } });
  if (!upsert.ok) await failed(upsert, "make the creations tag");
  const found = ((await upsert.json()) as Array<{ id: string; value: string }>).find((t) => t.value === tag);
  if (!found) throw new HttpError(502, "Immich didn't return the creations tag.");
  const res = await call(cred, "PUT", `/api/tags/${encodeURIComponent(found.id)}/assets`, { json: { ids } });
  if (!res.ok) await failed(res, "tag the creation");
}
