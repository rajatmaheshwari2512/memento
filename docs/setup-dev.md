# Run Memento on your own computer (dev)

Dev is a throwaway copy of Memento on your computer. It has a test admin, a few made-up photos
and a fake Gemini. You can try everything without a server and without spending money. Nothing
in dev reaches a real server.

This guide is for a person and for an AI agent. Steps marked **MANUAL** need a person. To run
Memento for real, on a server, see [setup-prod.md](setup-prod.md); it also compares dev and prod.

## The short version

```
git clone <your repo> memento && cd memento
./memento dev up
```

Open the link it prints: `http://localhost:8091/__local_login`. You're logged in as the test admin.

## What you need

1. **MANUAL:** install Docker. That's the only program you need. Immich's code, with Memento's
   website and app, comes with the repo in `immich/`.
   - Mac: Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/).
   - Linux: Docker Engine with the Compose plugin (https://docs.docker.com/engine/install/).
2. **MANUAL, Linux only:** let your user use Docker, then log out and back in:
   `sudo usermod -aG docker $USER`. Don't run `./memento` as root or with `sudo`: it refuses.
3. **MANUAL:** start Docker and wait until it's running. On a Mac: `open -a Docker`.
4. Give Docker at least 8 GB of memory (dev used up to 5.5 GB) and about 15 GB of disk.
   Docker Desktop: Settings → Resources.
5. A Mac with Apple chips, or another ARM64 computer. x86-64 should work too (the creations
   container builds there now), but dev hasn't been tried end to end on one.

If Docker is missing, not running, or not allowed for your user, `./memento` stops and says what
to do.

## The commands

| Command | What it does |
|---|---|
| `./memento dev up` | Starts dev and prints the login link. The first time, it also downloads and builds everything. |
| `./memento dev down` | Stops dev. Your test data stays. |
| `./memento dev reset` | Stops dev and deletes its data (`.local/dev/`). Downloads stay. |
| `./memento dev logs [service] [--no-follow]` | Every container's log, or one (`memento-extras`, `immich-server`, `immich-web`, …). `--no-follow` prints and stops. |
| `./memento dev status` | Shows what's running, and the link. |
| `./memento dev sample-memories` | Adds two "on this day" memories of the test photos, one with a Memento title ("Spotlight: …"). |
| `./memento dev config immich` (or `memento`) | Shows the merged compose files. **It prints secrets:** dev's passwords, the login token, and a real Gemini key if you set one. |

`down` and `reset` only stop dev's own containers. Another Immich on your computer is left alone.

## How long it takes

On a Mac with Apple chips:

- **The very first start** (an estimate; not timed from an empty Docker) downloads about 10 GB:
  Immich's images, the website's packages, Ask's reader model and what Memento's images are built
  from. Expect 15–30 minutes, depending on your connection. **If the first `up` times out, run it
  again:** it carries on where it stopped.
- The first time smart search runs, it downloads its models (about 2 GB) in the background.
- **After `reset`:** about 1 minute 40 seconds (downloads are kept).
- **After `down`:** about 1 minute 40 seconds. Most of it is the website dev server starting.
- **`up` while it's running:** about 10 seconds.

## Settings (optional)

Dev runs with no settings at all. To change something, copy `.env.example` to `.env` and fill in
the line you want. Or give it for one run: `DEV_ML=0 ./memento dev up`. To use another file
than `.env`: `MEMENTO_ENV_FILE=/path/to/file ./memento dev up`.

| Setting | What it does |
|---|---|
| `DEV_ML=0` | No smart search or faces. Less memory and a quicker start. |
| `DEV_WEB` | Where the website comes from (see below). |
| `DEV_WEB_DIST` | With `DEV_WEB=dist`: the built website's folder. |
| `DEV_GEMINI_API_KEY` | AI Edit uses the real Gemini. **Every edit costs money.** `up` says so. Empty: the free fake. |
| `DEV_NIGHT_RULES=1` | Prod's night rules: no collages, recaps or Reduce noise from 00:30 to 07:00. Empty: any hour. |
| `DEV_TZ` | The time zone, like `Europe/London`. Empty: your computer's. |
| `READER_MODEL_DIR` | Ask's reader model (see below). |
| `MUSIC_DIR` | Music for recap videos (see below). |

`.env` is never copied into a container. `./memento` reads only these settings from it. Each
container gets only its own values, in files under `.local/dev/` that only you can read.

AI Edit's limits are prod's: 10 edits a day per person, 75 a month in all. An admin can change
them in Administration → Settings → Memento features.

### The website (`DEV_WEB`)

- `container` (the default): the website from `immich/`, in Docker. Save a file and the page
  updates. The first start installs its packages, which takes a minute or two.
- `dist`: a built website (`apps/web/build.sh`), served by Immich the way prod serves it.

### Ask's reader (`READER_MODEL_DIR`)

Ask uses a small trained model to pick people, dates and places out of a question.

- If `READER_MODEL_DIR` is set, dev uses that folder (`config.json`, `tokenizer.json`, `model.onnx`).
- Otherwise it downloads the model from Hugging Face (`mahesraj/memento-ask-reader`, a fixed
  version, about 210 MB) and checks each file's fingerprint (sha256). A file that doesn't match is
  deleted. The download is kept in `.local/reader-model/`, so `reset` doesn't download it again.
- With no model, dev starts without the reader and prints a warning. Ask still works: it searches the question as typed, and says so.

### Music for recaps (`MUSIC_DIR`)

**MANUAL, optional:** recap videos pick a track from a folder of music files. The tracks can't be
in the repo, because their licence doesn't allow it. [deploy/music/tracks.md](../deploy/music/tracks.md)
lists them, with where to download each and what to name it.

- Set `MUSIC_DIR` to your folder. If it isn't set, dev uses `.local/recap-music/tracks` when that
  folder exists.
- Without music, recap videos are silent. Nothing else changes.

## What's fake in dev

- **The test admin** (`admin@local.test`). The login link logs you in without a password.
- **The test photos:** made-up pictures with dates and places, but no faces. On a Mac there's a
  HEIC one too. You can upload your own; they stay on your computer.
- **Gemini:** a fake that returns the photo redrawn, with "FAKE AI EDIT" across it. It's free.
- **Themed memories and live albums** check once a day, not every 5 minutes. Run them by hand:
  `POST /extras/memories/run` and `POST /extras/live-albums/<id>/check`, or add sample ones with
  `./memento dev sample-memories`.

## For an AI agent

- Log in by the link, keeping its cookies, then use them:
  ```
  curl -s -c /tmp/memento-dev.cookies -o /dev/null http://localhost:8091/__local_login
  curl -s -b /tmp/memento-dev.cookies http://localhost:8091/api/users/me
  ```
  In a browser, open the link.
- The test admin's files are in `.local/dev/seed/`: `session.env` (the login token, `LOCAL_TOKEN`)
  and `credentials.env` (the password). Use the link or `session.env`; never print either file.
- Logs without following: `./memento dev logs memento-extras --no-follow`.

## Dev's limits

- No backups and no restores.
- No HTTPS, real domain or certificates.
- No night schedule: night captions don't run. The "not at night" rules are off unless you set
  `DEV_NIGHT_RULES=1`.
- AI Edit is fake unless you add a key, and then every edit costs money.
- No Oracle, Cloudflare or AWS.
- The test photos are generated. You can add your own, but they stay on your computer.
- Smart search and faces run on your computer's processor: they're fine, but slower.
- Immich's own settings are Immich's defaults (for example the smaller ViT-B-32 search model). Prod's
  changes are listed in [setup-prod.md](setup-prod.md#mementos-immich-settings); set them in
  Administration → Settings to try them in dev.
- No iPhone app (prod doesn't have one either).
- Only this computer can reach it: every port listens on `127.0.0.1`, and the proxy only answers
  `localhost` and `127.0.0.1`. A phone can't reach it yet.

## How it's put together

| File | What it is |
|---|---|
| `immich/docker/docker-compose.yml` | Immich's own file, unedited, the same one prod uses. `up` checks its fingerprint against prod's (`immich_compose_sha256` in `host/roles/immich/defaults/main.yml`). |
| `deploy/dev/immich.yml` | Dev's changes to it: `127.0.0.1` only, machine learning optional. |
| `deploy/memento/compose.yml` | Memento's three containers. Prod will use it from a later step; today it renders the same as prod's file. |
| `deploy/dev/memento.yml` | Dev's changes: built from your clone, code that reloads, the fake Gemini, the proxy. |
| `deploy/dev/web.yml` | The website dev server (`DEV_WEB=container`). |
| `deploy/dev/Caddyfile` | The proxy: the same paths as prod, plus the login link. |
| `.local/dev/` | Dev's data and settings. `reset` deletes it. |
| `.local/reader-model/` | Ask's downloaded reader model. `reset` keeps it. |

- Ports, all on `127.0.0.1`: 8091 (the proxy, the one to use), 2283 (Immich), 3005 (memento-extras).
- `memento-extras` runs your `memento-extras/src`. Save a file and it restarts in a second or two.

## Troubleshooting

- **"Docker is installed but not answering."** Start Docker and wait. If Docker Desktop is open
  but stuck, quit it and open it again.
- **"Your user isn't allowed to use Docker yet"** (Linux). Do step 2 of "What you need".
- **"Another "immich" project is on this computer."** Two Immichs can't run at once, because
  Immich's file fixes the names. Stop the other one with the command the message gives.
- **"Port 8091 is taken."** Something else uses the port. Stop it first.
- **The first `up` timed out.** Run `./memento dev up` again.
- **The page says 502.** The website is still starting. `./memento dev logs immich-web` shows it.
- **Smart search finds nothing.** Its models download the first time (about 2 GB), and new photos
  are processed in the background. Wait a few minutes.
- **A fresh start:** `./memento dev reset`, then `./memento dev up`.

## Not tested yet

- Linux, and x86-64 computers (see "What you need").
