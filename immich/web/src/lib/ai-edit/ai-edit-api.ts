// SelfPhotos: calls to Memento's extras service (memento-extras, was ai-edit) at /extras on the same domain.
// Not part of Immich. The browser sends the Immich login cookie with these requests on
// its own, and the service asks Immich who the user is. See the SelfPhotos repo,
// memento-extras/README.md, for the service's API.

export type AiEditUsage = {
  today: { used: number; limit: number };
  thisMonth: { used: number; limit: number; estimatedCostUsd: number };
};

// How many more edits can be made today: your daily limit, or everyone's monthly one if that's
// closer.
export const editsLeft = ({ today, thisMonth }: AiEditUsage) =>
  Math.max(0, Math.min(today.limit - today.used, thisMonth.limit - thisMonth.used));

export type AiEditCreated = { editId: string; imageUrl: string; usage: AiEditUsage };

const BASE = '/extras';

// AiEditError's code when an edit's picture couldn't be loaded (getAiEditImage).
export const IMAGE_UNAVAILABLE = 'image_unavailable';

// The service's code for a photo too large for AI edits (ai/ai-tools.ts MAX_PHOTO).
export const PHOTO_TOO_LARGE = 'photo_too_large';

// status 0: the service couldn't be reached (`cause`: why, as the browser said it).
export class AiEditError extends Error {
  readonly status: number;
  readonly usage?: AiEditUsage;
  // Why, in a word: the service's reason when it gives one (e.g. PHOTO_TOO_LARGE), or
  // IMAGE_UNAVAILABLE.
  readonly code?: string;
  // The message is the service's own words (plain, for people), not one made here.
  readonly fromService: boolean;

  constructor(
    status: number,
    message: string,
    details: { usage?: AiEditUsage; code?: string; fromService?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.status = status;
    this.usage = details.usage;
    this.code = details.code;
    this.fromService = details.fromService ?? false;
  }
}

const UNREACHABLE = "Couldn't reach Memento's extras service. Check your connection.";

// A failure's message, to show.
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// `body` goes as JSON, or a Blob as it is (with its own type): the service refuses
// POST/PUT/DELETE without a type other sites can't send (its cross-site guard). `timeoutMs`:
// give up after that long (counted as unreachable).
export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: { 'content-type': body instanceof Blob ? body.type : 'application/json' },
      body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    throw new AiEditError(0, UNREACHABLE, { cause: error });
  }
  if (response.status === 204) {
    return undefined as T;
  }
  let data: { error?: string; code?: string; usage?: AiEditUsage } | null = null;
  try {
    data = (await response.json()) as { error?: string; code?: string; usage?: AiEditUsage };
  } catch {
    // not JSON (e.g. the service is down and something else answered)
  }
  if (!response.ok) {
    throw new AiEditError(response.status, data?.error ?? `AI edit failed (${response.status}).`, {
      usage: data?.usage,
      code: data?.code,
      fromService: typeof data?.error === 'string',
    });
  }
  return data as T;
}

export const getAiEditUsage = () => request<AiEditUsage>('GET', '/limits');

// SelfPhotos feature flags (Administration → Settings → Memento Features). Any logged-in
// user can read them; only an admin can change them.
export type MementoFlags = {
  // tools: the AI tools (presets and highlighting); a service from before them doesn't list it.
  gemini: { enabled: boolean; tools?: boolean; allow4k: boolean; dailyLimitPerUser: number; monthlyLimitTotal: number };
  liveAlbums: { enabled: boolean };
  askPhotos: { enabled: boolean };
  captions: { enabled: boolean };
  adjust: { enabled: boolean };
  // Optional: a service from before themed memories doesn't list them.
  themedMemories?: { enabled: boolean };
  creations?: { enabled: boolean };
  // Optional: a service from before Reduce noise for videos doesn't list it.
  reduceNoise?: { enabled: boolean };
};
export type MementoFlagsResponse = { flags: MementoFlags; defaults: MementoFlags };

export const getMementoFlags = () => request<MementoFlagsResponse>('GET', '/flags');

export const updateMementoFlags = (flags: MementoFlags) => request<MementoFlagsResponse>('PUT', '/flags', flags);

export type AiEditOptions = {
  // Edit that earlier result again ("Edit more") instead of the original.
  fromEditId?: string;
  // The AI tools selected (ai/ai-tools.json), if any: their instructions are already in the prompt.
  tools?: string[];
  // For an edit of a highlighted area (ai/ai-area.ts): the photo with that area tinted red, and
  // for a first edit the photo itself, upright.
  mark?: Blob;
  photo?: Blob;
};

// The mark goes base64 in the JSON request.
const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).replace(/^data:[^,]*,/, '')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error("Couldn't read the highlighted copy.")));
    reader.readAsDataURL(blob);
  });

export const createAiEdit = async (assetId: string, prompt: string, options: AiEditOptions = {}) =>
  request<AiEditCreated>('POST', options.mark ? '/edits/area' : '/edits', {
    assetId,
    prompt,
    fromEditId: options.fromEditId,
    tools: options.tools?.length ? options.tools : undefined, // none: a typed instruction
    mark: options.mark ? await base64(options.mark) : undefined,
    photo: options.photo ? await base64(options.photo) : undefined,
  });

// `whole`: an edit of a highlighted area saved as the AI made it, not pasted (the person chose it).
export const saveAiEdit = (editId: string, whole = false) =>
  request<{ assetId: string }>('POST', `/edits/${encodeURIComponent(editId)}/save`, whole ? { whole: true } : {});

// How a highlighted edit's result was lined up with the photo (numbers only), for the service's
// log, where the refusal threshold is tuned. Fire and forget.
export const reportAlignment = (
  editId: string,
  report: {
    scaleX: number;
    offsetX: number;
    scaleY: number;
    offsetY: number;
    error: number;
    patches: number;
    refused: boolean;
  },
) => request<void>('POST', `/edits/${encodeURIComponent(editId)}/alignment`, report).catch(() => {});

// An edit of a highlighted area: the original with that area of the result pasted on, at full
// size (ai/ai-area.ts pasteBack), saved like saveAiEdit.
export const saveAiEditArea = (editId: string, image: Blob) =>
  request<{ assetId: string }>('POST', `/edits/${encodeURIComponent(editId)}/save-area`, image);

export const discardAiEdit = (editId: string) => request<void>('DELETE', `/edits/${encodeURIComponent(editId)}`, {});

export const aiEditImageUrl = (editId: string) => `${BASE}/edits/${encodeURIComponent(editId)}/image`;

// An edit's picture (the Android app's AiEditService.image). Fails with status 0 when the
// service can't be reached, otherwise with code IMAGE_UNAVAILABLE.
export async function getAiEditImage(editId: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(aiEditImageUrl(editId));
  } catch (error) {
    throw new AiEditError(0, UNREACHABLE, { cause: error });
  }
  if (!response.ok) {
    throw new AiEditError(response.status, `Couldn't load the edited photo (${response.status}).`, {
      code: IMAGE_UNAVAILABLE,
    });
  }
  return response.blob();
}

// Adjust (sliders, filters, straighten): the photo rendered here at full size, saved as a
// copy with the original's date and place, stacked on top of it. Returns the copy's ID.
export const saveAdjustedCopy = (assetId: string, image: Blob) =>
  request<{ assetId: string }>('POST', `/adjust/${encodeURIComponent(assetId)}/save`, image);
