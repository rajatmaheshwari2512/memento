import { backupController } from "../controllers/backup.controller.ts";
import type { Route } from "../types/http.types.ts";

export const backupRoutes: Route[] = [
  { method: "GET", path: "/backup/settings", handler: backupController.settings }, // { quality }
  { method: "PUT", path: "/backup/settings", handler: backupController.changeSettings }, // { quality: "original" | "saverHigh" | "saver" }
];
