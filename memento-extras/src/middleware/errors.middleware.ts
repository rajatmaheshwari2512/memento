import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../utils/http-error.ts";
import { log, send } from "../utils/http.ts";

// Turns a failed request into a reply: our own errors as they are, anything else as a
// plain 500 (the details only go to the log).
export function sendError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (!req.complete) res.setHeader("connection", "close");
  if (error instanceof HttpError) return send(res, error.status, { error: error.message, ...error.extra });
  log({ event: "crash", path: req.url, error: error instanceof Error ? error.stack : String(error) });
  send(res, 500, { error: "Something went wrong in Memento's extras service." });
}
