import { adminController } from "../controllers/admin.controller.ts";
import type { Route } from "../types/http.types.ts";

// Admins only.
export const adminRoutes: Route[] = [
  { method: "GET", path: "/admin/settings", handler: adminController.settings }, // the flags, their defaults, and how to show each
  { method: "GET", path: "/admin/usage", handler: adminController.usage }, // everyone's AI edits, and their daily limits
  { method: "PUT", path: "/admin/users/:id/limits", handler: adminController.setDailyLimit }, // { dailyEdits: n | null } one person's daily limit
];
