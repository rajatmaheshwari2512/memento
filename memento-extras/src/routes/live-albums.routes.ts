import { liveAlbumsController } from "../controllers/live-albums.controller.ts";
import type { Route } from "../types/http.types.ts";

export const liveAlbumsRoutes: Route[] = [
  { method: "GET", path: "/live-albums", handler: liveAlbumsController.list }, // your live albums
  { method: "POST", path: "/live-albums", handler: liveAlbumsController.create }, // { albumId | albumName, include, match, exclude?, since? }
  { method: "PUT", path: "/live-albums/:id", handler: liveAlbumsController.update }, // { include, match, exclude?, since? } (also resumes a paused one)
  { method: "DELETE", path: "/live-albums/:id", handler: liveAlbumsController.remove }, // stop it (the album and its photos stay)
  { method: "POST", path: "/live-albums/:id/check", handler: liveAlbumsController.check }, // check for new photos now
];
