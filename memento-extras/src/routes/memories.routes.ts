import { memoriesController } from "../controllers/memories.controller.ts";
import type { Route } from "../types/http.types.ts";

export const memoriesRoutes: Route[] = [
  { method: "GET", path: "/memories/settings", handler: memoriesController.settings }, // { enabled, creations, pausedReason, lastRunDay }
  { method: "PUT", path: "/memories/settings", handler: memoriesController.changeSettings }, // { enabled?, creations? }
  { method: "GET", path: "/memories/labels", handler: memoriesController.labels }, // { memories: [{ memoryId, theme, label, memoryAt, showAt, hideAt }] }
  { method: "POST", path: "/memories/run", handler: memoriesController.run }, // { creations? }: make what's due today now
];
