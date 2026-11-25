# memento-extras

Memento's extras service: the features we add on top of Immich without changing its server image. Today that's AI edits ([AI.md](../AI.md), phase 2) and the feature flags (FEATURES.md, "Feature flags"); live albums and the rest of [FEATURES.md](../FEATURES.md) come next. It was called **ai-edit** until 2026-11-19.

**AI edits:** it takes one of your Immich photos and an instruction ("remove the people in the background"), has Gemini edit it, and saves the result next to the original, stacked with it. The original is never changed.

**Reduce noise for videos:** your own video's sound cleaned up on this server by DeepFilterNet (a small open speech-enhancement model, in the creations container), saved as a copy stacked on the original; the picture isn't touched. Free: nothing leaves the server.

It runs on the server as its own container, behind Caddy at `https://photos.example.com/extras/`. Ansible builds and deploys it (`host/roles/memento_extras`).

## How it works

```
app / browser ──(Immich login)──▶ Caddy /extras/* ──▶ memento-extras :3005
                                                         │ ├─(same login)──▶ Immich: who is this? the photo? upload the result
                                                         │ └─(image + text only)──▶ Gemini
                                                         └─ data/: results for 1 hour, limits + feature flags database
```

- **No logins of its own.** It reads your Immich login from the request (the web app's cookie, the Android app's `x-immich-user-token` header, or an API key for testing) and asks Immich who you are. Share-link keys are refused.
- **Your own photos only.** You can't edit photos you can only see through a partner or a shared album.
- **What Google gets:** the photo (the original, or Immich's preview for RAW and very large files; see `SOURCE`) and your instruction. Not your login, name or location. Requests are sent with `store: false`.
- **Limits:** per user per day, and a total per month, checked before Google is called. Failed edits don't count. The Google prepaid balance is the hard cap.
- **Feature flags:** an Immich admin switches Memento's own features on or off in Administration → Settings → Memento features (our web patch). The service stores them (`src/services/flags.service.ts`) and refuses anything switched off; the apps hide its buttons. First group: Gemini AI edits (on/off, the AI tools, allow 4K, the two limits). Off pauses a feature and deletes nothing.
- **Safe to serve under Immich's domain:** only JSON and JPEG/PNG/WebP (checked by their bytes) are ever returned, with `nosniff`. POST, PUT and DELETE need `Content-Type: application/json`, and there are no CORS headers, so other websites can't use your login here.

## API

Paths as Caddy forwards them (it removes `/extras`):

| Request | Does |
| --- | --- |
| `GET /health` | `{ ok: true }`, no login needed |
| `GET /flags` | `{ flags, defaults }`: the feature flags in force and their defaults. Any logged-in user (the apps hide switched-off features) |
| `PUT /flags` e.g. `{ gemini: { enabled: false } }` | changes the settings given (all checked first; one bad value changes nothing). Admins only, logged in (not with an API key). Returns `{ flags, defaults }`. A value set back to its default follows the default again |
| `GET /limits` | your edits today, and everyone's this month with an estimated cost; `fourKOverPixels`: photos bigger than this are edited at 4K (if the admin allows it), so the apps show the price of the size an edit will be |
| `GET /admin/settings` | `{ flags, defaults, settings }`: as `GET /flags`, plus how to show each setting (section, title, subtitle, kind, range), which the Android app's Memento admin draws its list from. Admins only, logged in (not with an API key) |
| `GET /admin/usage` | everyone's AI edits (today, this month, estimated cost) and daily limits, plus the month's total. Admins only, logged in (not with an API key) |
| `PUT /admin/users/:id/limits` `{ dailyEdits }` | one person's AI-edit daily limit (0–1000), or `null` for everyone's default. Admins only, logged in. Returns the same as `GET /admin/usage` |
| `POST /edits` `{ assetId, prompt, fromEditId?, tools? }` | makes an edit, returns `{ editId, imageUrl, size, usage }`. With `fromEditId`, edits that result again instead of the original (at its size). The size is automatic (`IMAGE_SIZE`): 4K for photos over ~5 MP as shown (with Immich's own crop) if the admin allows 4K, otherwise 2K. An edit whose request was closed while it waited its turn isn't made (nothing counted). A highlighted edit's images sent here (an app from before `/edits/area`) get 426 "please update the app". `tools`: the app's preset ids picked for this edit, 1 to 3 different ones (the app joins their instructions and the typed words into `prompt`); only the count and the names are checked here, which tools go together is the apps' rule. An app from before picking several sends `tool`, one id, taken as `[tool]`; both at once is a 400. A single tool picks the provider (`src/services/edit-providers.service.ts`; Gemini for every tool today), several go to Gemini; 403 when the `gemini.tools` switch is off. The log names the tools, never the instruction. A photo over 100 megapixels, or over 12,000 px on its longer side (as shown, with Immich's own crop), is refused with 413 and `code: "photo_too_large"` before anything is downloaded or counted (`/edits/area` too). At most 8 edits are made at once; more wait their turn, up to 24 for up to 3 minutes, else 503. No image is held whole in memory: the photo goes to a file in the edit's own folder under `DATA_DIR`, to Google as base64 a piece at a time, and Google's result back into a file (measured with `npm run bench:edits`: 8 at once peaked at about 170 MB, where 2 at once took 300 MB before; the numbers are in `src/constants/edits.constants.ts`). The folder is removed when the edit ends; 507 when `DATA_DIR` has less than `ADJUST_MIN_FREE_BYTES` free |
| `POST /edits/area` `{ assetId, prompt, fromEditId?, tools?, mark, photo }` | an edit of a highlighted area, otherwise as `/edits`. `mark`: the photo with that area tinted red (base64 JPEG/PNG/WebP, at most 3 MB; the apps send ~1.5K px). `photo`: the photo itself, upright as the app shows it (at most 6 MB; the apps send ≤3K px), for a first edit; "Edit more" works on the earlier result. Gemini gets the photo, then the mark, with "change only the highlighted area": both upright and framed alike, whatever Gemini does with an original's rotation tag. The request may be up to ~12 MB; its type and declared size, the login and both switches (`gemini.enabled`, `gemini.tools`) are checked before it's read, and it's read only in its turn, as it arrives: both images are decoded into files, and the rest is kept only up to 16 KB |
| `GET /edits/:id/image` | the result, only for whoever made it, sent from disk |
| `POST /edits/:id/save` `{ whole? }` | uploads it to your library with the original's date and place, stacks it on top of the original. Returns `{ assetId }`. Safe to retry. An edit of a highlighted area only with `whole: true` (the person chose the whole result, e.g. because it couldn't be lined up with the photo); otherwise 400 |
| (later, phase 2) | an edit of a highlighted area sends the whole photo at 4K today (~₹12); phase 2 will send only a crop around the area at 2K (~₹4–5.5) and paste it back at full size (FEATURES.md, "Cutting Gemini's cost"). Not built |
| `POST /edits/:id/save-area` body: the photo (`image/jpeg`, or `image/png` for PNG originals; up to 100 MB) | for an edit of a highlighted area: Gemini redraws fine detail across the whole photo, so the app pastes only the highlighted area of the result (lined up with the photo, with a soft edge) onto the original at full size and sends that photo. Refused (400) for an edit that wasn't of a highlighted area, or a photo whose size (read from its header) isn't the original's as shown: each side may be up to 10% smaller (a RAW photo's full-size picture is the JPEG inside it, a little smaller than the photo; the apps accept it too), never larger, the same way round and shape within 1%; Immich's preview is far smaller and is refused. Saved like `/save` (named, dated, stacked; only by whoever made the edit; safe to retry), streamed to disk like Adjust's save, taking turns with it. 403 when `gemini.enabled` or `gemini.tools` is off |
| `POST /edits/:id/alignment` `{ scaleX, offsetX, scaleY, offsetY, error, patches, refused }` | how the app lined a highlighted edit's result up with the photo before pasting (numbers only), logged so the apps' refusal threshold can be tuned on real edits. 204 |
| `DELETE /edits/:id` | discards it. Unsaved results are deleted after an hour anyway |
| `POST /adjust/:assetId/save` body: the photo (`Content-Type: image/jpeg`, or `image/png` for PNG originals; up to 100 MB) | Adjust (sliders, filters, straighten): the app renders the adjusted photo at full size on the device and sends it; it's saved like an AI edit, as a copy with the original's date and place, stacked on top. Returns `{ assetId }`. 403 when the `adjust` flag is off. Saves (AI Edit's too) run up to 20 at a time (a guard; normal use never reaches it); more wait their turn, up to 50 waiting for up to 2 minutes, else 503. 507 when `DATA_DIR` has less than `ADJUST_MIN_FREE_BYTES` free. Your own photos only, not the locked folder. The upload goes to a file under `DATA_DIR`, never whole into memory |
| `POST /ask` `{ question, timeZone?, language?, cursor? }` | Ask Photos: a question in plain English → `{ understood, assets, nextCursor }`. `understood` is how it was read (people, dates, videos, favourites, leftover words, hints); `assets` are Immich's own photo records, best match first, or newest first when no words are left (then `nextCursor` pages on). "The last time …" / "earliest …" sort by date instead (`understood.order`). `timeZone` (e.g. `Asia/Kolkata`) is for "last December". 403 when the `askPhotos` flag is off. The question isn't logged |
| `GET /memories/settings` | your themed memories: `{ enabled, creations, pausedReason, lastRunDay }` |
| `PUT /memories/settings` `{ enabled?, creations? }` | `enabled: true` makes your own limited key for them (logged in, not with an API key; refused while the `themedMemories` switch is off); `false` deletes it in Immich, and memories already made stay. `creations` is your own choice about collages, recap videos, animations and cinematic photos (default on) |
| `GET /memories/labels` | `{ memories: [{ memoryId, theme, label, memoryAt, showAt, hideAt }] }`: the short label ("Spotlight: Mom", "Best of October") Memento's apps show where unpatched ones show "N years ago", by Immich's memory id. Sunday's cards (the week's collage, recap, animation and cinematic photo) are listed too, labelled like the memory they were made from |
| `POST /memories/run` `{ creations? }` | makes whatever's due today now, instead of at 07:05; answers what was made and skipped. `creations: true` also queues this week's collage, recap, animation and cinematic photo now instead of on Sunday (still one card a week). 429 while someone's run is going, or within 10 minutes of your last |
| `POST /videos/:assetId/reduce-noise` `{}` | Reduce noise: starts cleaning one of your own videos' sound and answers at once, 202 `{ jobId, state: "queued" }`. Checked first: the `reduceNoise` switch (403), your own video, not in the trash, the locked folder or a live photo's hidden half (403/400), at most 10 minutes and 2 GB as Immich describes it (413), MP4/M4V, MOV, MKV, WebM or 3GP (415), not in the night captions' hours nor so close to them that it couldn't finish (503, saying when to try again), room in the work folder for 2 × the video + 4 GB (`REDUCE_NOISE_MIN_FREE_BYTES`; 507), and room in the line: one cleaned at a time for everyone, 3 more waiting (503 with `code: "busy"`). Asked again for a video already in line: the same job. The line is in memory with the caller's login (never stored); a waiting job waits while the creations container is busy or the morning's memories run is going, up to 45 minutes (`REDUCE_NOISE_WAIT_SECONDS`). The copy (`services/reduce-noise.service.ts`): the original's picture as it was, the cleaned sound, its name with `-reduce-noise` and its extension, the original's date and place, stacked on top. Not a creation: no tag, album or memory. The video is never held in memory: downloaded to the work folder, and the copy uploaded straight from the work folder (no second copy on disk) with Node's own HTTP client (`uploadFile`; fetch held a whole upload in memory). A copy made before and since put in the trash (the same bytes: Immich answers "duplicate" with it) is restored from the trash and stacked; if Immich won't, the job fails saying so (AI Edit's and Adjust's saves the same). Measured with `npm run bench:reduce-noise`: 180–190 MB peak for 2 GB in and 2.1 GB out |
| `GET /videos/jobs/:id` | how your job is going: `{ jobId, state: queued \| running \| done \| failed, assetId? (the copy, once done), error? (why not, in words for the person) }`. Only your own jobs (404 otherwise). After a restart, jobs that were in line answer `failed`, "try again" |

Errors are `{ error: "message you can show the user" }`, with status 400, 401, 403, 404, 413 (`code: "photo_too_large"` for a photo too large to AI-edit), 415, 422 (Gemini refused or got no image), 429 (a limit was hit), 503 (Google out of credit or busy) or 507 (the server's disk is nearly full).

## Settings

Environment variables, read in `src/config.ts`. On the VM, Ansible writes them from `host/roles/memento_extras/defaults/main.yml`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | (required) | from `.env` |
| `GEMINI_MODEL` | `gemini-nano-banana-2.1` | or `gemini-3-pro-image` |
| `IMAGE_SIZE` | `auto` | `auto`: 4K when the original is over ~5 MP (e.g. phone photos), otherwise 2K, for every edit; "Edit more" keeps the size. Or `1K`, `2K`, `4K` for every edit. Gemini returns that size class with the photo's shape, not the original's exact pixel size. The apps show the price by the same rule (`immich/web/src/lib/ai-edit/ai/ai-tools.json`) |
| `COST_USD_1K` / `_2K` / `_4K` | `0.0336` / `0.0504` / `0.113` | estimated price per edit, for the log and the monthly estimate |
| `SOURCE` | `auto` | `auto`: the original (with Immich's crop/rotate applied) when Gemini can read it (JPEG, PNG, WebP, HEIC) and it's at most `MAX_ORIGINAL_BYTES`, otherwise Immich's preview (RAW, huge files). Gemini applies phones' rotation tags itself (tested). `preview`: always the preview |
| `MAX_ORIGINAL_BYTES` | `14680064` (14 MB) | Google limits a request to about 20 MB, and the image is sent base64 |
| `DAILY_LIMIT_PER_USER` / `MONTHLY_LIMIT_TOTAL` | `20` / `150` | the defaults for the two limits (Ansible sets 10 / 75). An admin can override them in the admin panel |
| `GEMINI_URL` | Google's Interactions API | only changed by the tests, to a fake |
| `MAX_PROMPT_CHARS` | `1500` | up to 3 AI tools' instructions joined with the typed words (500 at most) |
| `RESULT_TTL_MINUTES` | `60` | |
| `IMMICH_URL` | `http://immich-server:2283` | |
| `DATA_DIR` | `/data` | |
| `ADJUST_MIN_FREE_BYTES` | `2147483648` (2 GB) | saves (Adjust's, AI Edit's) and AI edits are refused below this much free space in `DATA_DIR` (uploads wait there on the way to Immich, up to 20 × 100 MB; each AI edit's files are there while it's made) |
| `REDUCE_NOISE_MIN_FREE_BYTES` | `4294967296` (4 GB) | Reduce noise is refused (507) unless the work folder has this much free on top of twice the video (the original and its copy) |
| `REDUCE_NOISE_WAIT_SECONDS` | `2700` (45 minutes) | how long a video may wait its turn (behind a creation or the morning's memories run) before it's given up |
| `CREATIONS_URL` | `http://memento-creations:8000` | the creations container (`creations/`) |
| `CREATIONS_WORK_DIR` | `/work` | the folder shared with it, one folder per job, emptied after |
| `RENDER_QUIET_HOURS` | `00:30-07:00` | no render starts in these hours (the night captions'); `""` for none |
| `CREATIONS_CHECK_SECONDS` / `MEMORIES_CHECK_SECONDS` | `60` / `300` | how often the render worker and the day's memories check look for work |
| `MEMORIES_RUN_AT` | `07:05` | when the day's themed memories are made (local time): after the night captions |

## Code

TypeScript with **no npm dependencies**: Node 24 runs `.ts` files directly (it strips the types), and the HTTP server, `fetch` and SQLite are built into Node. `npm install` only adds the TypeScript checker, for your Mac.

Each request goes: `routes/` (which URL) → `controllers/` (login, the feature's on/off switch, checking the request against `schemas/`, the reply) → `services/` (the work). Laid out like Immich's server, without a framework.

```
src/server.ts        starts everything up and shuts it down
src/config.ts        the settings, from environment variables

src/routes/          every URL, one file per area; index.ts finds the one for a request
src/controllers/     one function per route: who's asking, what they sent, what to answer
src/services/        the work; no requests or replies (a refusal is an HttpError):
  edits                AI edits: make, show, save next to the original (as made, or pasted
                       onto the original by the app for a highlighted area), discard
  edit-providers       which provider makes an AI edit, chosen per tool (Gemini today)
  free-first           where a free tool will answer an edit before Gemini (no worker yet)
  adjust               Adjust's save: a photo the app adjusted, saved next to the original
  copies               the one save path for both, and for videos' cleaned copies: upload the copy
                       (streamed from a file), the original's date and place, stacked on top
  reduce-noise         Reduce noise for videos: the checks, the line (one at a time), the job
                       (download, the creations container, the copy saved like an edit)
  limits               limits on AI edits
  flags                feature flags
  live-albums          live albums and their 5-minute check
  memories             themed memories: the day's run, labels and settings
  memory-themes        what's due (home, trips, big days, Spotlight) and the labels (pure)
  memory-picks         choosing a memory's photos, an animation's burst, a cinematic photo's photo (pure)
  memory-library       reading the timeline, the photo search and people from Immich
  memory-quality       sharpness and exposure of a memory's best candidates (the creations container)
  memory-key           each person's own key for memories and creations
  api-key              people's own keys for background work (live albums, memories), shared
  schedule             when memories and renders may run: the run time, quiet hours, one run at a time
  creations            collages, recaps, animations, cinematic photos: weekly pick, the queue, its one worker
  creation-render      making one: inputs to the container, upload, tag, album, memory
  ask, ask-reader      Ask Photos: the trained reader's labels → a search plan; Immich's
                       search + the caption search, merged
  ask-parser           dates and People-page names in a phrase the model marked (pure, no I/O)
  ask-places           the place the model marked, in the asker's own places
  captions             asking llama-server for one photo's caption (no database, so the
                       backlog script can run it on its own)
  caption-records      loading a results file; removing captions of photos gone for good
  repositories/        everything that reads or writes the database or stored files:
    edits                results waiting to be saved or discarded (files)
    limits               the edit log and per-person limits
    flags                admins' overrides of the switches
    live-albums          live albums, their people, the photos they've seen, users' keys
    memories             who turned themed memories on (their key), each memory and its label
    creations            the creations queue (also the record of every one made), photo quality, albums
    reduce-noise         the record of each video cleaned (and its state, which the apps ask)
    captions             captions table + full-text search
src/middleware/      runs on requests: auth (finds the Immich login, asks Immich who it is,
                     cached 1 min; requireUser, requireSessionUser, requireAdmin), security
                     headers, errors → replies
src/clients/         calls to other services: immich (every call to Immich's API), gemini
                     (the call to Google, one edit provider: another goes next to it and is
                     chosen per tool in services/edit-providers)
src/schemas/         what each request and stored value must look like, and the checks
src/types/           the TypeScript types, one file per area
src/constants/       fixed values (limits, the caption prompt, the tag list, messages)
src/db/              database.ts (the SQLite file, its versions, the hourly backup copy),
                     migrations.ts (every table, as numbered steps: the one place to read it)
src/utils/           small helpers: JSON replies and the log, HttpError, encryption, image types,
                     time zones
creations/           the creations container: Node (no packages) driving vips and ffmpeg
                     (collage, recap, animation, cinematic; video.ts what the videos share),
                     Python's onnxruntime for the depth model (depth.py; parallax.ts moves the
                     camera), and DeepFilterNet's deep-filter for Reduce noise (noise.ts); its
                     own Dockerfile, built on the VM like reader/. check-reduce-noise.sh checks
                     Reduce noise end to end on the Mac (builds the image, cleans test videos)
src/scripts/         run by hand or at night, not by the server:
  caption-backlog      one-off: every preview → llama-server → a results file
  import-captions      loads a results file into the captions table
  caption-night        new photos' captions, at night on this server (docs/runbooks.md)
```

All the SQLite tables are in one file (`<DATA_DIR>/data.db`).

Captions get in through `import-captions.ts` (the backlog) and `caption-night.ts` (new photos, each night); Ask Photos (`POST /ask`) is what searches them. How the backlog is run: docs/runbooks.md, "Caption the backlog on it".

## Run it on your Mac (against the real Immich)

```sh
cd memento-extras
npm install            # type checker only
npm run check          # type check
npm test               # runs the service against a fake Immich and a fake Gemini (free)
npm run bench:edits    # AI edits' peak memory, 1 to 16 at once (fakes, free; see the file for Linux)
GEMINI_API_KEY=... IMMICH_URL=https://photos.example.com DATA_DIR=/tmp/memento-extras PORT=3005 npm start
curl -H "x-api-key: <an Immich API key>" localhost:3005/limits
```

Every real edit costs money (about $0.05 at 2K, $0.11 at 4K), so test the limits with small values, like `DAILY_LIMIT_PER_USER=2`.
