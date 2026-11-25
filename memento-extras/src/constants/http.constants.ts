// Requests and logins: body size, ID and token shapes, the login cache, the secret box
// format.

export const MAX_JSON_BYTES = 16 * 1024;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tokens are hex or base64-like. Anything else is refused, so it can't smuggle extra
// header lines or cookies into the request to Immich.
export const LOGIN_TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;

export const LOGIN_CACHE_MS = 60_000;

export const SECRET_BOX_VERSION = 1;

// How long a request may take to arrive in full: a 100 MB photo from a phone on a slow
// connection (Adjust's save). Set on the server explicitly, not left to Node's default.
export const REQUEST_TIMEOUT_MS = 5 * 60_000;

// Uploading a copy to Immich (up to 100 MB, on the same machine).
export const UPLOAD_TIMEOUT_MS = 3 * 60_000;
