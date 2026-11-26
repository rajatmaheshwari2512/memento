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

// Only plain UUIDs are accepted as IDs.
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
