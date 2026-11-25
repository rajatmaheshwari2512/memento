import { adjustController } from "../controllers/adjust.controller.ts";
import type { Route } from "../types/http.types.ts";

export const adjustRoutes: Route[] = [
  { method: "POST", path: "/adjust/:id/save", handler: adjustController.save }, // body: the adjusted photo -> { assetId } of the copy
];
