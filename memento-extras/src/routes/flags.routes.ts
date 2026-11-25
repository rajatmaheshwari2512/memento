import { flagsController } from "../controllers/flags.controller.ts";
import type { Route } from "../types/http.types.ts";

export const flagsRoutes: Route[] = [
  { method: "GET", path: "/flags", handler: flagsController.get }, // the feature flags in force, and their defaults
  { method: "PUT", path: "/flags", handler: flagsController.update }, // change some, e.g. { gemini: { enabled: false } } (admins only)
];
