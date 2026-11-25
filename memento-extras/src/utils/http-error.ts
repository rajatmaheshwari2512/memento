import { UUID } from "../constants/http.constants.ts";

// An error that becomes an HTTP response with this status and a message the user can read.
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// IDs go into URL paths and file names, so only plain UUIDs are accepted.
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
