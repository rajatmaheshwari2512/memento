// Routes and their handlers (routes/, controllers/).

import type { IncomingMessage, ServerResponse } from "node:http";

// A controller: the request, the response, and the route's :params by name.
export type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

export type Route = { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; handler: Handler };
