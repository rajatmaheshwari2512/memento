# Memento

Memento is a photo library you run yourself, in the spirit of Google Photos. It is built on
[Immich](https://immich.app), the open-source photo server. Your photos stay on your own server.
Memento keeps everything Immich does and adds editing, smarter search, memories and creations
on top.

It comes as a website and an Android app. There is no iPhone app.

## What it adds to Immich

- **AI Edit.** Describe a change ("remove the people in the background"), or pick up to three
  one-tap presets. Brush over part of the photo with **Highlight** to change only that part.
  Google's Gemini makes the edit. The result is saved as a new copy, stacked on the original.
  The original is never changed.
- **Adjust.** Light and colour sliders, filters and straighten, plus **Auto** (one tap to fix
  light and colour), **Perspective** (drag four corners to make lines straight) and **Markup**
  (pen, highlighter, text, arrows and shapes). Free, and done on your device and server.
- **Reduce noise for videos.** Cleans up the sound of a video, such as wind or a noisy room.
  Saved as a copy; the picture isn't touched.
- **Ask Photos.** Ask a question in plain English or Hinglish, like "Mom and me at the beach
  last December", and get the photos. A small model trained for this picks out the people,
  places and dates. Every night, a captioning model writes a short description of each new photo,
  so you can also search for what's in it.
- **Themed memories.** Next to Immich's "years ago" memories: "Spotlight: Mom", "Best of
  October", "Goa trip, 2023".
- **Weekly creations.** Once a week, for each person: a collage, a recap video with music, an
  animation and a cinematic photo (a still photo that moves in 3D). They're saved into the
  library like any other photo.
- **Live albums.** Albums that fill themselves with new photos of the people you choose.
- **Feature switches.** Admins turn each feature on or off, and set AI Edit's limits, from
  Immich's own settings page.
- **Admin on the phone.** Immich's own Android app has no admin controls; Memento's does. From
  the phone, an admin can see the server's overview and usage, add people, set their storage
  and AI Edit limits, make or remove admins, reset a password, remove or restore a person, and
  turn features on or off.

The apps say "Memento" in place of "Immich", with their own logo.

## Guides

- [Try it on your computer (dev)](docs/setup-dev.md): free, with test photos and a fake Gemini.
- [Run it on a server (prod)](docs/setup-prod.md): setup, the Android app, backups and restores,
  and how dev and prod differ.
- [Upgrades](docs/upgrades.md): new Memento changes, and new Immich releases.

## How it's built

- **Immich v3.4.2** does the heavy lifting: storing photos, faces, smart search, the timeline.
  Its server runs exactly as Immich ships it. Memento changes only Immich's website (SvelteKit)
  and Android app (Flutter); that code is in `immich/`.
- **Memento's service** (`memento-extras/`) runs next to Immich and handles everything new. It's
  a small Node.js service in TypeScript, with no framework and an SQLite database. It talks to
  Immich's API as the signed-in user, and to Gemini for AI edits.
- **Ask's reader** is a small language model fine-tuned from Google's MuRIL to label each word of
  a question (person, place, date, thing). It runs in its own small Python container. The
  model is published on Hugging Face.
- **Night captions** come from Qwen3.5-2B, run by llama.cpp on the server between 00:30 and
  07:00, when nobody is using it.
- **The creations container** makes collages, videos and cinematic photos with libvips and
  ffmpeg, a depth model (Depth Anything V2) for the 3D effect, and DeepFilterNet for noise. It
  has no internet access.
- **Dev:** one command starts the whole thing in Docker on your computer: the same setup and
  addresses as a real server, made-up test photos, a free fake in place of Gemini, and a link
  that logs you in as a test admin.
- **Prod:** Ansible sets up the server: Docker, Caddy with free HTTPS certificates, Immich,
  Memento and nightly encrypted backups to Amazon S3 Glacier Deep Archive. Terraform can
  create the server itself (Oracle Cloud's free ARM server), the DNS records (Cloudflare) and
  the backup bucket.

## Where things are

| Path | What it is |
|---|---|
| `./memento` | The one command: `./memento dev …` on your computer, `./memento prod …` for a server, `./memento android` for the app. |
| `immich/web` | The website (Immich's, with Memento's changes). Ours is mostly in `web/src/lib/ai-edit/`. |
| `immich/mobile` | The Android app (Immich's, with Memento's changes). Ours is in `mobile/lib/selfphotos/`. |
| `memento-extras/` | Memento's service (`src/`); `reader/` is Ask's reader; `creations/` the creations container. |
| `deploy/` | The Docker Compose files, and the music list. |
| `host/` | Ansible: sets up the server. |
| `infra/` | Terraform: creates the server, DNS and backup bucket (optional). |
| `apps/` | Builds the website and the Android app; the logo. |
| `scripts/` | `privacy-check.sh`, run before pushing. |
| `docs/` | The guides: `setup-dev.md` (dev), `setup-prod.md` (a server), `upgrades.md`. |

## Try it on your computer

You need Docker, and a Mac with Apple chips (or another ARM64 computer).

```
git clone <this repo> memento && cd memento
./memento dev up
```

Then open the link it prints. The full guide is [docs/setup-dev.md](docs/setup-dev.md).

## Run it for real

The full guide is [docs/setup-prod.md](docs/setup-prod.md). In short:

```
cp .env.example .env          # then fill in the PROD part: .env.example says what each line is
./memento prod check          # what's missing, and which optional parts are on
./memento prod setup          # tools, generated passwords, server/DNS/bucket (asks first), then the deploy
./memento prod deploy         # later deploys; ./memento prod dry-run shows what would change
```

The server is Ubuntu 24.04, ARM64 or x86-64: yours (`SERVER_HOST`), or Oracle Cloud's free ARM
server, which setup makes with Terraform. (On a server that isn't Oracle's, setup doesn't finish
yet: [the known gap](docs/setup-prod.md#two-ways-to-get-a-server).) Cloudflare DNS and backups
are optional too. Back up
`.env`, and `infra/terraform.tfstate` once setup has made anything: it's Terraform's only record of
the server, DNS record and bucket (without it, setup would make a new server).

- **Done for you:** installing Terraform, Ansible and rclone; the generated passwords; the Oracle
  server, the DNS record and the backup bucket (Terraform shows its plan and waits for you to type
  `yes`); setting up the server, HTTPS, Immich, Memento, the models, nightly captions, memories,
  creations and backups; the Android app's signing key (`./memento android keystore`).
- **By hand (MANUAL):** a domain, a Gemini API key, and the accounts for the optional parts
  (Oracle Cloud, Cloudflare, AWS); filling in `.env`; downloading the recap music; and a few
  choices in Immich's admin settings.

**What costs money:** among Memento's features, only AI Edit. Each edit is a paid call to Gemini
(about $0.05, or $0.11 for a 4K result), with daily and monthly limits you set. Everything
else runs on your own server for free. Running a server has its own costs, such as a domain
name and backup storage.

## Models and music

- **Ask's reader:** [huggingface.co/mahesraj/memento-ask-reader](https://huggingface.co/mahesraj/memento-ask-reader)
  (Apache-2.0). Dev downloads a fixed version by itself and checks its fingerprint.
- **Captions:** [Qwen3.5-2B in GGUF form](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF), downloaded
  at a fixed version by the server setup.
- **Music for recaps:** from Pixabay, free to use but not ours to pass on, so it isn't in this
  repo. The list of tracks, with where to download each and what to name it, is in
  [deploy/music/tracks.md](deploy/music/tracks.md). Put them in `.local/recap-music/tracks/`
  (or the folder `MUSIC_DIR` names in `.env`). Without music, recaps are silent.

## Licence and credits

- **Memento's own code:** MIT ([LICENSE](LICENSE)).
- **`immich/`:** Immich's code, under the GNU AGPL-3.0 ([immich/LICENSE](immich/LICENSE)). Our
  changes to it are AGPL-3.0 too.

Built on the work of:
- [Immich](https://immich.app), the photo server and apps underneath it all;
- [MuRIL](https://huggingface.co/google/muril-base-cased) by Google, the base of Ask's reader,
  trained with [Hinglish-TOP](https://github.com/google-research-datasets/Hinglish-TOP-Dataset)
  (Google Research), [MASSIVE](https://huggingface.co/datasets/AmazonScience/massive) (Amazon) and
  place names from [GeoNames](https://www.geonames.org);
- [Qwen3.5](https://huggingface.co/Qwen) and [llama.cpp](https://github.com/ggml-org/llama.cpp),
  for the captions;
- [SigLIP 2](https://huggingface.co/immich-app/ViT-B-16-SigLIP2__webli) by Google, for smart search
  (chosen in Immich's settings);
- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet), for Reduce noise;
- [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2), libvips and ffmpeg,
  for the creations;
- [Gemini](https://ai.google.dev) by Google, for AI Edit.
