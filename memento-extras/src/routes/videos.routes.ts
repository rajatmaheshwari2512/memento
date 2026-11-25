import { videosController } from "../controllers/videos.controller.ts";
import type { Route } from "../types/http.types.ts";

export const videosRoutes: Route[] = [
  { method: "POST", path: "/videos/:assetId/reduce-noise", handler: videosController.reduceNoise }, // {} -> 202 { jobId, state }
  { method: "GET", path: "/videos/jobs/:id", handler: videosController.job }, // { jobId, state, assetId?, error? }
];
