import { healthController } from "../controllers/health.controller.ts";
import type { Route } from "../types/http.types.ts";

export const healthRoutes: Route[] = [
  { method: "GET", path: "/health", handler: healthController.get }, // is it running (for Docker; no login needed)
];
