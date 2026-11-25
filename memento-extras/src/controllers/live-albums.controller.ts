// Live albums. Changes create and delete a key in the user's name, so they need a logged-in
// app or browser, not an API key.

import { requireSessionUser, requireUser } from "../middleware/auth.middleware.ts";
import { parseNewLiveAlbum, parseRules } from "../schemas/live-albums.schema.ts";
import {
  checkNow, createLiveAlbum, deleteLiveAlbum, listLiveAlbums, requireLiveAlbums, updateLiveAlbum,
} from "../services/live-albums.service.ts";
import type { Handler } from "../types/http.types.ts";
import { readJson, send } from "../utils/http.ts";

export const liveAlbumsController = {
  async list(req, res) {
    const { user } = await requireUser(req);
    send(res, 200, listLiveAlbums(user));
  },

  async create(req, res) {
    const body = await readJson(req); // the JSON content type is also the cross-site guard
    const { user, cred } = await requireSessionUser(req);
    requireLiveAlbums();
    send(res, 201, await createLiveAlbum(user, cred, parseNewLiveAlbum(body)));
  },

  async update(req, res, { id }) {
    const body = await readJson(req);
    const { user, cred } = await requireSessionUser(req);
    requireLiveAlbums();
    send(res, 200, await updateLiveAlbum(user, cred, id!, parseRules(body)));
  },

  // Works when live albums are switched off, so people can still stop theirs.
  async remove(req, res, { id }) {
    await readJson(req);
    const { user, cred } = await requireSessionUser(req);
    await deleteLiveAlbum(user, cred, id!);
    send(res, 204);
  },

  async check(req, res, { id }) {
    await readJson(req);
    const { user } = await requireSessionUser(req);
    requireLiveAlbums();
    send(res, 200, await checkNow(user, id!));
  },
} satisfies Record<string, Handler>;
