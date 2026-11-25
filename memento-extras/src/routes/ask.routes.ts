import { askController } from "../controllers/ask.controller.ts";
import type { Route } from "../types/http.types.ts";

export const askRoutes: Route[] = [
  // { question, timeZone?, language?, cursor? } -> { understood, assets, nextCursor }
  { method: "POST", path: "/ask", handler: askController.ask },
];
