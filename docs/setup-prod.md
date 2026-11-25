# Run Memento on a server (prod)

Prod is Memento for real: your photos on a server you control, at your own `https://` address,
with the Android app, the night captions and nightly backups. One command sets the server up;
another updates it after a change.

This guide is for a person and for an AI agent. Steps marked **MANUAL** need a person. To try
Memento first, without a server or any cost, use dev: [setup-dev.md](setup-dev.md).

## Dev or prod?

| | Dev (your computer) | Prod (a server) |
|---|---|---|
| Who it's for | Trying Memento, or changing its code | You and your family's real photos |
| Start it | `./memento dev up` | `./memento prod setup` once, then `./memento prod deploy` |
| Address | `http://localhost:8091`, logged in as a test admin | `https://photos.example.com` (your domain), with free HTTPS certificates |
| AI Edit (Gemini) | A free fake, unless you add a key | Real, with your key: each edit is paid |
| Backups | None | Every night, encrypted, to Amazon S3 Glacier Deep Archive (optional, strongly advised) |
| Night jobs | None. Captions don't run; the "not at night" rules are off | Captions 00:30–07:00, Immich's database copy at 02:00, the backup at 04:00 |
| Data | Made-up test photos; thrown away with `./memento dev reset` | Your photos, on the server's disk |
| Phone app | Can't reach it | The Android app, at your address |
| Immich's settings | Immich's defaults | Memento's choices, set by you once ([below](#mementos-immich-settings)) |
| Costs | Nothing | A domain, AI edits, backup storage; the server is free if it fits Oracle's free allowance |

Dev's full list of limits is in [setup-dev.md](setup-dev.md#devs-limits).

## The short version

```
cp .env.example .env && chmod 600 .env   # MANUAL: fill in the PROD parts
./memento prod check                     # what's missing, and which optional parts are on
./memento prod setup                     # MANUAL: in a terminal; asks you to type yes
```

Then open your address and make the admin account. The rest of this guide is each step in detail.

## Two ways to get a server

**a. Setup makes one on Oracle Cloud.** Terraform makes Oracle's free ARM server (2 cores, 12 GB
of memory, 200 GB of disk), its network, and a spending alert. This is how Memento is run
today. Fill in the ORACLE part of `.env` and leave `SERVER_HOST` empty.

**b. Your own server.** Any Ubuntu 24.04 server, ARM64 or x86-64: a cloud server or one at home.
Put its address in `SERVER_HOST` and leave the ORACLE part empty.

> **Known gap, path b:** the server setup still expects Oracle's Ubuntu image. Before it opens
> ports 80 and 443, it checks Oracle's firewall file (`/etc/iptables/rules.v4`). A server that
> isn't Oracle's usually doesn't have that file, so the first deploy stops at the step
> **"Check the firewall file looks like Oracle's"**. Until that's fixed (in `host/roles/caddy`),
> path b doesn't finish on its own. Path b hasn't been tried end to end.

Either way, Cloudflare DNS and backups are optional parts you turn on in `.env`.

## What you need

### On your computer

- A Mac, or Linux with `apt`. Setup installs Terraform, Ansible and rclone for you (on a Mac,
  with Homebrew: **MANUAL:** install it from https://brew.sh first).
- **Docker**, running: the website is built on your computer, in Docker. See
  [setup-dev.md](setup-dev.md#what-you-need).
- git, Python 3 and openssl (a Mac and most Linux computers have them).
- **An SSH key.** If you don't have one: `ssh-keygen -t ed25519`. Setup and Ansible use your
  normal SSH setup to log in to the server.

### Accounts (MANUAL)

| Account | Needed? | What for |
|---|---|---|
| **A domain** | Yes | The address people open, like `photos.example.com`. Any registrar. |
| **Google AI Studio** (aistudio.google.com) | Yes | A Gemini API key for AI Edit, with billing on. Each edit is paid. |
| **Oracle Cloud** (cloud.oracle.com) | Path a | The server. Upgrade the account to **Pay As You Go** (below). |
| **Cloudflare** | Optional | If your domain's DNS is on Cloudflare, setup makes the DNS record. Otherwise you add it by hand. |
| **AWS** | Optional, strongly advised | The backups. Without them, nothing is copied off the server: if its disk is lost, the photos are lost. |

### The server

- **Ubuntu 24.04**, ARM64 or x86-64.
- **About 2 cores and 12 GB of memory.** That's Oracle's free server, and Memento's memory limits
  are set for it. Less memory hasn't been tried: the night captions alone may use 3 GB, and smart
  search's model about 3 GB while it works through your photos.
- **Disk:** room for your photos and videos, plus some tens of GB for Ubuntu, the programs,
  the models and the thumbnails (which grow with your library). Oracle's free server has 200 GB.
- **Ports 80 and 443 open to everyone** (HTTPS, and the certificates). Port 22 (SSH) open to
  you. Oracle's path opens these for you.
- **SSH with your key**, as a user that can `sudo` without a password (`ubuntu` unless you set
  `SERVER_USER`).
- **A server at home:** forward ports 80 and 443 on your router to it, and use a fixed public
  address (or update the DNS record when it changes). If your internet provider blocks those
  ports or shares one address among many homes, the certificates can't be made.

## Step by step

### 1. MANUAL: the accounts

- **Gemini:** aistudio.google.com → Get API key. Turn on billing. When Google's prepaid balance
  runs out, AI Edit pauses until you add more; nothing else stops.
- **A domain:** buy one, and pick the name for Memento in it, like `photos.example.com`.
- **Oracle (path a):**
  1. Sign up at cloud.oracle.com with a card.
  2. Pick your **home region** carefully. It can't be changed later, and the free server is
     only in your home region.
  3. Upgrade to **Pay As You Go**. The free allowance still applies, and it's far more likely
     to get a free ARM server: accounts on the free tier alone rarely do, and their idle
     servers can be taken back.
  4. Install Oracle's CLI (Mac: `brew install oci-cli`) and run `oci setup config`. It asks for
     your user's and your tenancy's OCIDs (Oracle's console → your profile) and your region,
     then writes `~/.oci/config` and an API key.
  5. Add the public key it made in Oracle's console: your profile → API keys → Add API key.
- **Cloudflare (optional):** dash.cloudflare.com → My Profile → API Tokens → Create Token →
  "Edit zone DNS", for your domain only.
- **AWS (optional, strongly advised):**
  1. Make an account. Make an IAM user with admin rights for yourself (not the root login), and
     an access key for it.
  2. Install the AWS CLI (Mac: `brew install awscli`) and run `aws configure --profile <name>`
     with that key. Setup uses the profile to make the bucket and a backup user that can add
     files but never delete them. You'll use the same profile for restores.

### 2. MANUAL: fill in `.env`

```
cp .env.example .env && chmod 600 .env
```

`.env` holds every setting and secret. It's never committed. Each line of `.env.example` says
what it is, its default, where to get it, and what happens if it's empty. Fill in, by part:

| Part in `.env.example` | When | What |
|---|---|---|
| `PROD: REQUIRED` | Always | `MEMENTO_DOMAIN`, `GEMINI_API_KEY`, and `TZ` (your time zone, like `Asia/Kolkata`; the night jobs and AI Edit's daily limits follow it) |
| `PROD: YOUR OWN SERVER` | Path b | `SERVER_HOST`, and `SERVER_USER` if it isn't `ubuntu` |
| `PROD: ORACLE SERVER` | Path a | `OCI_TENANCY_OCID`, `OCI_BUDGET_AMOUNT`, `OCI_BUDGET_EMAIL`; the others have defaults |
| `PROD: CLOUDFLARE DNS` | Optional | `CLOUDFLARE_API_TOKEN` |
| `PROD: BACKUPS` | Optional, strongly advised | `BACKUP_BUCKET_NAME` (unique across all of AWS, like `memento-backup-<random letters>`), `AWS_REGION`, `AWS_PROFILE` |
| `GENERATED` | Leave empty | Setup fills these in and never changes one that's set |
| `ANDROID` | Optional | Only to keep the app's signing key somewhere else |

Leave the `DEV` parts alone; prod doesn't read them.

You can make the backup bucket yourself instead (with versioning on, and a user that may only
add and read files). Then fill in `BACKUP_ACCESS_KEY_ID` and `BACKUP_SECRET_ACCESS_KEY` instead
of `AWS_PROFILE`, and make the two backup passwords yourself: two long random passwords, saved
in your password manager, each put into `.env` as `rclone obscure -` prints it. Letting setup make
the bucket is simpler.

### 3. `./memento prod check`

It reads `.env`, changes nothing, and prints:

- **Optional parts:** which are on (Oracle server, Cloudflare DNS, backups).
- **To fill in or fix:** each setting that's missing or wrong, and where to get it. Fix them and
  run it again until this list is gone.
- **`./memento prod setup` fills in:** the generated settings. Before the first setup, this list
  is expected: check ends with "Not ready yet: ./memento prod setup fills in the rest."

### 4. MANUAL: `./memento prod setup`

Run it yourself, in a terminal. It:

1. installs what's missing: Ansible, Terraform (only if a Terraform part is on), and rclone (only
   to make the backup passwords);
2. fills in the empty generated settings: the database password, Memento's secret, the two backup
   passwords and the Android key's password;
3. **shows the two backup passwords once.** **MANUAL: save them in your password manager now.**
   Without them, nobody can read the backups;
4. if Oracle, Cloudflare or AWS is on: shows Terraform's plan, then waits. **MANUAL: read the
   plan, then type `yes`** (or `new server` when the plan makes an Oracle server; it costs
   nothing within the free allowance). Anything else stops, and nothing changes. Setup refuses
   on its own any plan that would delete something;
5. deploys: builds the website on your computer, then sets up the server with Ansible.

When it first connects to a new server, SSH may ask "Are you sure you want to continue
connecting?". **MANUAL: type `yes`.**

The first deploy takes a while: it downloads Immich and the models onto the server and builds
Memento's three images there. If setup stops, fix what it says and run it again: it carries on
where it stopped.

It ends with: "Memento is at https://photos.example.com. Still by hand (MANUAL):" and a list.

### 5. MANUAL: the DNS record (only without Cloudflare)

Point `MEMENTO_DOMAIN` at the server: an **A record** to its IPv4 address. If your DNS provider
has a proxy (Cloudflare's orange cloud), keep it **off** ("DNS only"): a proxy stops uploads over
100 MB, so long videos would fail.

| | With Cloudflare | Without Cloudflare |
|---|---|---|
| **Path a (Oracle)** | Setup makes the record. Nothing to do. | Setup makes the server, deploys to its address, and prints the record to add. Add it before your next deploy: later deploys reach the server by `MEMENTO_DOMAIN`. |
| **Path b (yours)** | `SERVER_HOST` must be the server's IPv4 address; setup makes the record. | Add the record before setup. |

HTTPS starts working on its own once the record points at the server: Caddy, the program in front
of Memento, keeps trying to get the certificate. To check the record: `dig +short photos.example.com`
prints the server's address.

### 6. MANUAL: make the admin account, right away

Open `https://photos.example.com`. **The first person to sign up becomes the admin**, so do it
straight after setup. Then add the others: Administration → Users.

### 7. MANUAL: Memento's Immich settings

Setup doesn't change Immich's own settings. Set them once, in the browser:
[the table below](#mementos-immich-settings).

### 8. MANUAL: check Memento's switches

Administration → Settings → **Memento Features**. Every feature starts on. Here you switch each
one off or on for everyone (AI Edit, Adjust, Ask Photos, captions, memories, live albums, Reduce
noise), and set AI Edit's limits: 10 edits a day per person and 75 a month in all, to start
with.

Each person turns their own themed memories and creations on in Account settings → Themed
memories.

### 9. MANUAL, optional: music for recaps

[deploy/music/tracks.md](../deploy/music/tracks.md) lists the tracks, where to download each,
and what to name it. Put them in `.local/recap-music/tracks/` at the top of the repo, then run
`./memento prod deploy`. It copies every `.mp3` from there to the server. (`MUSIC_DIR` is for
dev only.) Without music, recap videos are silent.

### 10. MANUAL: back these up, in a password manager

| What | Why |
|---|---|
| `.env` (the whole file) | Every secret: the database password, Memento's secret, the backup keys and passwords. Save it again whenever you change it. |
| The two backup passwords | Shown once by setup. Without them, the backups can't be read. |
| `infra/terraform.tfstate` | Once setup has made anything with Terraform. It's Terraform's only record of the server, the DNS record and the bucket; without it, setup would make a new server. Save it again after each Terraform change. |
| The Android signing key | The file at `ANDROID_KEYSTORE_PATH` (default `~/.config/selfphotos/android/selfphotos-immich.jks`). Every update of the app must be signed with it. |

### 11. Recommended: test the backup

Don't wait for a disaster. Upload one photo, then run the backup now:

```
ssh ubuntu@photos.example.com
sudo systemctl start --no-block deep-archive-backup
journalctl -u deep-archive-backup -f     # wait for "All copies done"; Ctrl-C stops watching, not the backup
```

Then, on your computer, make the [restore settings](#the-restore-settings-on-your-computer) with
the passwords **from your password manager**, set the two `export` lines there, and list the
backup:

```
rclone lsf -R glacier_crypt: | head
```

You should see real file names. Listing needs no thaw and costs almost nothing. If it lists
nothing or shows errors, the saved passwords don't match: fix that now.

## Memento's Immich settings

In Administration → Settings. Immich keeps them in its own database, so they stay yours to change.

| Section | Setting | Memento's value | Immich's default |
|---|---|---|---|
| Machine Learning Settings → Smart Search | CLIP model | `ViT-B-16-SigLIP2__webli` | `ViT-B-32__openai` |
| Video Transcoding Settings → Transcode Policy | Accepted video codecs | H.264, HEVC, VP9, AV1 | H.264 |
| Video Transcoding Settings → Encoding Options | Target resolution | 1080p | 720p |
| Video Transcoding Settings → Encoding Options | Preset (-preset) | slow | ultrafast |
| Storage Template | Enable storage template engine; template | on, `{{y}}/{{MM}}/{{dd}}/{{filename}}` | off |
| Database Dump Settings | Amount of previous dumps to keep | 7 | 14 |

- **Smart search:** after changing the model, run Administration → Job Queues → Smart Search →
  **All**. Search finds nothing until it's done; on a small server, a big library takes a while.
- **Video:** most phone videos then play as they are, without a second copy. Only videos a
  browser can't play (and 10-bit HDR ones) get a copy, made smaller by "slow". If you change
  these later, run Job Queues → Transcode videos → **All**.
- **Storage template:** set it before you upload, so files land in dated folders from the start.
- **Database dumps:** Immich's own copy of its database, every night at 02:00, in
  `/opt/immich/library/backups/`. The backup sends the newest one off the server once a week.
- Face recognition and the trash stay at Immich's defaults.

## The Android app

There's no iPhone app. The app is built on your computer and installed by hand.

1. **MANUAL, once: the build tools.** The build is set up for a Mac with Homebrew. From the top
   of the repo:
   ```
   brew install mise
   brew install --cask android-commandlinetools   # then accept its licences: sdkmanager --licenses
   cd immich && mise trust mise.toml mobile/mise.toml native/mise.toml
   cd mobile && mise install aqua:flutter/flutter java rust
   cd .. && mise install node pnpm npm:@openapitools/openapi-generator-cli
   cd native && mise install rust
   ```
   These are the versions Immich pins. The steps are also at the top of `apps/android/build.sh`.
2. `./memento android keystore` makes the app's signing key, if there's none: the file at
   `ANDROID_KEYSTORE_PATH`, with its password in `.env` (`ANDROID_KEYSTORE_PASSWORD`). It never
   replaces a key. **MANUAL: back up the key file** (step 10).
3. `./memento android` builds the app: `apps/android/dist/memento-<version>-<commit>.apk`, for
   64-bit ARM phones (nearly all phones today).
4. **MANUAL:** install it. Copy the APK to the phone and open it (Android asks you to allow
   installs from that app), or with a USB cable:
   `adb install -r apps/android/dist/memento-<version>-<commit>.apk`.
   It installs next to Immich's own app; it doesn't replace it.
5. **MANUAL:** open Memento, enter the server address `https://photos.example.com`, then your
   email and password. Turn on backup in the app to upload the phone's photos.

To update the app, build it again and install it over the old one. It must be signed with the
same key, or the phone refuses the update.

## Day to day

### After a change

```
./memento prod dry-run    # what deploy (and Terraform) would change; changes nothing
./memento prod deploy     # applies only what changed
```

- Deploy builds the website when there's no build for this Immich version. After changing the
  website's code, use `./memento prod deploy --web` to build it again.
- Dry-run works once the server has been set up: on a new server, it can't preview steps that
  depend on earlier ones. It also needs the website built. On an unchanged server, a couple of
  steps (the package list refresh, the caption model's image check) always show as "changed".
- Other options go to Ansible, like `./memento prod deploy --tags memento_extras` for Memento's
  service only.

### What runs at night

All times are the server's time zone (`TZ`).

| When | What |
|---|---|
| 22:30 | Security updates: Ubuntu's, and Docker's and Caddy's within their major versions |
| 00:30–07:00 | Night captions: a small model describes new photos, so Ask can find what's in them. Nothing new starts after 07:00. |
| 02:00 | Immich's database copy |
| 04:00 | The backup to Deep Archive (only if backups are on) |
| 07:05 | Themed memories for the day. On Sundays, each person's weekly creations are queued. |

Collages, recap videos and Reduce noise never start between 00:30 and 07:00. A kernel update
needs a reboot, which isn't automatic: `ls /var/run/reboot-required && sudo reboot` on the server.

### What costs money

- **AI Edit:** each edit is a paid Gemini call, about $0.05, or $0.11 for a 4K result. The limits
  (10 a day per person, 75 a month in all, to start with) are in Memento Features. Google's
  prepaid balance is the hard cap.
- **The Oracle server:** free while it stays within Oracle's Always Free allowance. The server
  setup makes fits in it. The spending alert (`OCI_BUDGET_AMOUNT`) emails you if anything costs.
- **Backups:** S3 Glacier Deep Archive is about $1 per TB a month (a tenth of a cent per GB),
  plus a small fee per file uploaded. Replaced copies are kept 180 days, which Deep Archive bills
  anyway. **A restore costs more:** a fee to thaw, and AWS's download fee, around $90 per TB at
  the time of writing. Check AWS's current prices.
- **The domain:** a yearly fee to your registrar.
- Everything else (Ask, captions, memories, creations, Adjust, Reduce noise, smart search, faces)
  runs on your server, for free.

### Change the Gemini key

1. **MANUAL:** make a new key in AI Studio.
2. Put it in `.env` as `GEMINI_API_KEY`, with a text editor. (Not on a command line: it would
   stay in your shell's history.)
3. `./memento prod deploy`.
4. **MANUAL:** delete the old key in AI Studio, and save `.env` in your password manager again.

Other secrets:

- `IMMICH_DB_PASSWORD`: don't change it in `.env` alone. The database keeps the password it was
  made with.
- `MEMENTO_SECRET`: changing it pauses everyone's live albums until each person saves theirs
  again.
- The two backup passwords: can't be changed. Every file in the bucket was encrypted with them.

### Is everything OK?

From anywhere:

```
curl -s https://photos.example.com/api/server/ping    # {"res":"pong"}: Immich answers
curl -s https://photos.example.com/extras/health      # {"ok":true}: Memento's service answers
```

On the server (`ssh ubuntu@photos.example.com`):

```
cd /opt/immich && sudo docker compose ps             # Immich's containers: healthy
cd /opt/memento-extras && sudo docker compose ps     # memento_extras, memento_reader, memento_creations: healthy
systemctl list-timers deep-archive-backup caption-night   # the last and next runs
journalctl -u deep-archive-backup --since yesterday | tail   # ends with "All copies done"
journalctl -u caption-night --since yesterday | tail -1     # last night's captions, in one line
df -h /                                              # free disk
```

### Never do these

| Don't | Why |
|---|---|
| `terraform destroy` | It would try to delete the server and the bucket. |
| Edit files on the server that the setup manages | The next deploy puts them back. Change `host/` instead. |
| Turn on the DNS proxy | Uploads over 100 MB (videos) fail. |
| `rclone sync` into the bucket | `sync` deletes. The backup only ever copies. |
| Lose `.env` or the backup passwords | The backups can't be read without them. |

## Backups and restores

### What's backed up

Every night at 04:00, rclone copies to your S3 bucket, encrypted on the way with the two backup
passwords (file and folder names too). AWS only ever sees scrambled files.

- **Your photos and videos:** everything in `/opt/immich/library`, the originals and uploads.
- **Immich's database:** once a week, on Sundays, the newest nightly copy, always as
  `backups/latest.sql.gz`. Each week replaces the last; the bucket keeps every replaced copy 180
  days, so about six months of weekly copies are there.
- **Memento's own database** (live-album rules and their keys, feature switches, the AI Edit log,
  captions): Memento copies it every hour; the backup sends that copy every night.

Not backed up, because Memento rebuilds them from the originals: thumbnails, and the playback
copies of videos.

The backup only adds. A photo deleted in Memento stays in the backup. The server's backup user
can add and read files, but can't delete or thaw them.

**The limit:** photos go off the server every night, but Immich's database only once a week. If
the server is lost, every photo comes back, but changes from the last days (albums, people's
names, edits to dates) may not.

### The restore settings on your computer

Restores run on your computer with rclone (`brew install rclone`), and the AWS CLI for one file.
Thawing needs your admin AWS login (`AWS_PROFILE`): the server's backup user isn't allowed to.

Make `~/.config/memento/rclone.conf`, readable only by you
(`mkdir -p ~/.config/memento && touch ~/.config/memento/rclone.conf && chmod 600 ~/.config/memento/rclone.conf`):

```ini
[glacier]
type = s3
provider = AWS
env_auth = true
region = <AWS_REGION, like us-east-1>

[glacier_crypt]
type = crypt
remote = glacier:<BACKUP_BUCKET_NAME>/immich
password = <backup password 1, obscured>
password2 = <backup password 2, obscured>
filename_encryption = standard
directory_name_encryption = true
filename_encoding = base32

[glacier_memento]
type = crypt
remote = glacier:<BACKUP_BUCKET_NAME>/memento-extras
password = <backup password 1, obscured>
password2 = <backup password 2, obscured>
filename_encryption = standard
directory_name_encryption = true
filename_encoding = base32
```

"Obscured" is the form rclone keeps passwords in. Copy a password from your password manager, then
on a Mac: `pbpaste | rclone obscure -` (on Linux: `rclone obscure -`, then paste it). Every command
below assumes:

```
export RCLONE_CONFIG=~/.config/memento/rclone.conf
export AWS_PROFILE=<your admin profile>
```

### Restore one file

Files in Deep Archive must be thawed before they can be read: about 48 hours with "Bulk" (the
cheapest), about 12 with "Standard". Listing needs no thaw.

```
rclone lsf -R glacier_crypt: | grep '<part of its name>'        # find it, by its real name
rclone cryptdecode --reverse glacier_crypt: '<path it printed>'  # its scrambled name in the bucket
aws s3api restore-object --bucket <bucket> --key 'immich/<scrambled name>' \
  --restore-request '{"Days":7,"GlacierJobParameters":{"Tier":"Bulk"}}'
aws s3api head-object --bucket <bucket> --key 'immich/<scrambled name>' --query Restore
                                                                 # wait until it says ongoing-request="false"
rclone copy glacier_crypt:'<path it printed>' ~/Downloads/restore/   # decrypts on the way
```

Then upload the file again through the website (drag it onto the page).

### Restore everything (the server's disk is lost)

This hasn't been tried end to end. Read it through first.

1. **MANUAL, on your computer: thaw everything.** Then wait about 48 hours.
   ```
   rclone backend restore glacier:<bucket>/immich -o priority=Bulk -o lifetime=14
   rclone backend restore glacier:<bucket>/memento-extras -o priority=Bulk -o lifetime=14
   ```
2. **A server with Memento on it,** set up with this guide and **the same `.env`** (the same
   database password, Memento's secret and backup settings). Don't make an admin account on it:
   the restored database brings yours back. If the address is the same as before, forget the old
   server's SSH key first: `ssh-keygen -R photos.example.com`.
   - **If Oracle's server itself is gone,** setup stops: it refuses a plan that makes again
     something Terraform's state already has (that usually means a wrong setting). Replacing a
     lost Oracle server isn't handled by setup yet.
3. **On the server, stop the backup and Immich while you restore** (the next deploy starts them
   again):
   ```
   sudo systemctl stop deep-archive-backup.timer
   cd /opt/immich && sudo docker compose down
   ```
4. **Copy the photos back,** decrypting on the way. Run it inside `tmux`, so a dropped connection
   doesn't stop it. It uses the server's own backup settings:
   ```
   sudo bash -c 'set -a; . /etc/deep-archive-backup/glacier.env; exec rclone copy archive_immich: /opt/immich/library --transfers 4 -P'
   ```
5. **Restore Immich's database** from `/opt/immich/library/backups/latest.sql.gz`, with Immich's
   guide: docs.immich.app → Administration → Backup and Restore. In Memento, Immich's folder is
   `/opt/immich`, and its database folder (`DB_DATA_LOCATION`) is `/opt/immich/postgres`.
6. **Restore Memento's database:**
   ```
   cd /opt/memento-extras && sudo docker compose down
   sudo rm -f /opt/memento-extras/data/data.db-wal /opt/memento-extras/data/data.db-shm
   sudo bash -c 'set -a; . /etc/deep-archive-backup/glacier.env; exec rclone copyto archive_memento_extras:memento-extras.db /opt/memento-extras/data/data.db'
   sudo chown 10001:10001 /opt/memento-extras/data/data.db
   ```
7. **On your computer:** `./memento prod deploy`. It starts everything again, the backup too.
8. **MANUAL, in the browser:** Administration → Job Queues. Run **All** (not Missing: the
   restored database already lists the lost files) for: Extract metadata, Generate Thumbnails,
   then Transcode videos. The last one takes hours.

## Limits

- **No iPhone app.** The website works on an iPhone's browser.
- **One server.** Everything runs on it: no spare, no load sharing.
- **Path b doesn't finish yet** on a server that isn't Oracle's (the [known gap](#two-ways-to-get-a-server)).
- **The website and the app are built on your computer,** which needs Docker (and the Android
  tools for the app).
- **Immich's database goes off the server weekly,** the photos nightly (see "What's backed up").
- **Restores are slow and cost money:** about two days to thaw, and AWS's download fee.
- **Upgrades are yours to do:** [upgrades.md](upgrades.md).

## Troubleshooting

- **Check lists something "To fill in or fix".** Each line says where to get the value.
  `.env.example` has more.
- **"Out of host capacity" (Oracle).** Oracle has no free ARM server right now. Run setup again
  later; what's already made is kept.
- **`NotAuthorizedOrNotFound` on the first run (Oracle).** A new compartment takes a minute to
  work everywhere. Wait, then run setup again.
- **Setup refuses a plan** that deletes something or makes again what the state has. Check `.env`:
  a part turned off, or another region or account than before?
- **"Host key verification failed".** Run `ssh ubuntu@<address>` once, type `yes`, then run the
  command again. For a rebuilt server: `ssh-keygen -R <address>` first.
- **"Check the firewall file looks like Oracle's" fails.** The [known gap](#two-ways-to-get-a-server)
  on a server that isn't Oracle's.
- **The page doesn't open, or the certificate is wrong.** `dig +short photos.example.com` must
  print the server's address, and ports 80 and 443 must be open (the cloud provider's firewall,
  the server's own firewall, your router). Caddy's log: `sudo journalctl -u caddy --since "1 hour ago"`.
- **The page says 502.** Immich is still starting: `cd /opt/immich && sudo docker compose ps`.
- **"The web build is from …" (deploy stops).** The website was built for another Immich
  version: `./memento prod deploy --web`.
- **AI Edit says it's paused.** Google's prepaid balance is used up: add more in AI Studio.
- **Smart search finds nothing.** Its model is still downloading, or it's still working through
  your photos (Job Queues shows it).
- **The backup failed.** `journalctl -u deep-archive-backup --since yesterday` says which copy, and
  why. The next night tries again.

## For an AI agent

- **Never read or print `.env`.** It holds every secret. `./memento prod check` says what's
  missing without showing values.
- **A person runs `./memento prod setup`.** It needs a terminal to type `yes` (or `new server`),
  and shows the two backup passwords once. Don't run it, and never capture its output.
- **A person** makes the accounts, fills in `.env`, adds the DNS record by hand, makes the admin
  account, and sets Immich's settings in the browser.

The order, and what to check after each:

| Step | Command | Check |
|---|---|---|
| 1 | `./memento prod check` | No "To fill in or fix" list. Before the first setup, only the "setup fills in" list, ending "Not ready yet: ./memento prod setup fills in the rest." After it: "Ready: …". |
| 2 | (the person) `./memento prod setup` | It ends "Memento is at https://… Still by hand (MANUAL):" |
| 3 | `curl -s https://<domain>/api/server/ping` | `{"res":"pong"}` |
| 4 | `curl -s https://<domain>/extras/health` | `{"ok":true}` |
| 5 | After a change: `./memento prod dry-run` | Only the changes you expect, plus the couple that always show |
| 6 | `./memento prod deploy` | Ansible's summary at the end: `failed=0` |
| 7 | On the server: the commands in "Is everything OK?" | All containers healthy; the last backup ended "All copies done" |

Logs on the server: `sudo docker logs --tail 50 memento_extras` (Memento's service: one line per
edit, switch change or error, never the prompts), `journalctl -u deep-archive-backup`,
`journalctl -u caption-night`.

## Not tried yet

- **Path b** (your own server) end to end; see the [known gap](#two-ways-to-get-a-server).
- **x86-64 servers.** The images build for both, but Memento runs on ARM64.
- **`./memento prod setup` making a new Oracle server from nothing.** The Terraform and Ansible
  underneath it run Memento's own server.
- **Running setup from a Linux computer.**
- **A full restore** ("Restore everything" above).
