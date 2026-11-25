import { editsController } from "../controllers/edits.controller.ts";
import type { Route } from "../types/http.types.ts";

export const editsRoutes: Route[] = [
  { method: "GET", path: "/limits", handler: editsController.limits }, // your edits today, everyone's this month, the 4K threshold
  { method: "POST", path: "/edits", handler: editsController.create }, // { assetId, prompt, fromEditId?, tool? } -> { editId, size, ... }
  { method: "POST", path: "/edits/area", handler: editsController.createArea }, // as /edits, plus { mark, photo } -> { editId, size, ... }
  { method: "GET", path: "/edits/:id/image", handler: editsController.image }, // the result (only for the user who made it)
  { method: "POST", path: "/edits/:id/save", handler: editsController.save }, // { whole? } upload next to the original -> { assetId }
  { method: "POST", path: "/edits/:id/save-area", handler: editsController.saveArea }, // body: the result pasted onto the original -> { assetId }
  { method: "POST", path: "/edits/:id/alignment", handler: editsController.alignment }, // how the app lined it up (logged)
  { method: "DELETE", path: "/edits/:id", handler: editsController.discard }, // discard
];
