# Upgrades

**Upgrades are your job.** Nothing updates Memento or Immich on your server by itself, and nobody
else updates your copy. Only Ubuntu's security updates, and Docker's and Caddy's within their
major versions, install on their own (every night at 22:30). Read what changed, try it in dev
first, and keep your backups working.

There are two kinds of upgrade:

- **Memento:** new changes to this repo (its service, the website, the app, the server setup).
- **Immich:** a new Immich release, brought into `immich/`.

## Before any upgrade

1. **The backups work.** On the server, the last backup ended with "All copies done":
   `journalctl -u deep-archive-backup --since yesterday | tail`.
2. **A fresh copy of Immich's database.** **MANUAL:** Administration → Job Queues → Create job →
   Create Database Dump. It's saved on the server in `/opt/immich/library/backups/`.
3. **A copy of Memento's database.** Memento makes one every hour; put the latest aside:
   ```
   sudo cp -p /opt/memento-extras/data/backup/memento-extras.db /opt/memento-extras/memento-extras-before-upgrade.db
   ```

Why: Immich and Memento both update their database when a new version starts, and an older
version can't use the updated one (Memento refuses it, and stops). Going back means putting the
old code **and** the old database back, and losing what changed since. See
[Going back](#going-back).

## Update Memento

If you cloned Memento's repository and want its new changes:

```
git pull
git log --oneline ORIG_HEAD..HEAD     # what came in
./memento prod check                  # new settings in .env.example?
./memento prod dry-run                # what deploy would change on the server; changes nothing
./memento prod deploy
```

- **New settings:** `.env.example` may have new lines. To see which names `.env` doesn't have
  yet (names only, never values):
  `comm -23 <(grep -o '^[A-Z_0-9]*=' .env.example | sort) <(grep -o '^[A-Z_0-9]*=' .env | sort)`.
- **The website:** deploy builds it only when there's no build for this Immich version. If the
  pull changed the website (`git diff --stat ORIG_HEAD HEAD -- immich/web` shows files), use
  `./memento prod deploy --web` to build it again.
- **The app:** if the pull changed it (`git diff --stat ORIG_HEAD HEAD -- immich/mobile`), run
  `./memento android` and install the new APK on each phone.
- **A new Immich version** may come with the pull (`immich_version` in
  `host/roles/immich/defaults/main.yml` changed). Then read Immich's release notes and follow
  [After an Immich upgrade](#5-deploy-then-check) below.
- **Try it in dev first** if the change is big: `./memento dev up`.

If you have your own changes, merge as you would in any git repository; conflicts are yours to
fix.

## Upgrade Immich

Immich's code is in `immich/` as a plain folder: one Immich release, with Memento's changes to
its website and app. It isn't a git submodule. To move to a new release, you take what Immich
changed between your release and the new one, and apply it to that folder. Memento's changes
stay where they are.

Immich's server isn't changed by Memento: prod runs Immich's official images, at the version in
`immich_version`.

### 1. Read the release notes

github.com/immich-app/immich/releases: every release between yours and the new one. Look for
breaking changes, and for changes to `docker-compose.yml`. A patch release (v3.4.1 → v3.4.2) is
usually small. A new major version (v4) can mean real work.

### 2. Bring the new release into `immich/`

Start from a clean working tree (`git status` shows nothing to commit), on a new branch.

```
OLD=v3.4.2 NEW=v3.5.0     # yours (immich_version in host/roles/immich/defaults/main.yml), and the new one
git switch -c upgrade-immich-$NEW
git fetch --depth 1 --no-tags https://github.com/immich-app/immich.git \
  "refs/tags/$OLD:refs/tags/immich-$OLD" "refs/tags/$NEW:refs/tags/immich-$NEW"
git diff --binary --ignore-submodules "immich-$OLD" "immich-$NEW" > /tmp/immich-upgrade.patch
git apply --3way --directory=immich /tmp/immich-upgrade.patch
```

What each line does:

- `git fetch` downloads only the two releases (not Immich's whole history), as the tags
  `immich-<version>`.
- `git diff` writes everything Immich changed between them into one file, pictures included.
- `git apply --directory=immich` applies it inside `immich/`. With `--3way`, a file that Memento
  changed too is merged, not refused.

What you'll see:

- **"Applied patch to '…' cleanly."** for each file that merged by itself.
- **"Applied patch to '…' with conflicts."** where Immich changed lines that Memento changed too.
  Those files have conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`); `git status` lists them
  under "Unmerged paths". Edit each to keep both Immich's change and Memento's, then `git add` it.
  Memento's own code is mostly in `immich/web/src/lib/ai-edit/` and `immich/mobile/lib/selfphotos/`;
  in Immich's own files, most of Memento's lines carry a `SelfPhotos` comment.
- **"error: immich/… : does not exist in index"**, and nothing is applied. Immich changed a file
  that Memento's copy leaves out (`.vscode/settings.json`, for example). Make the patch again
  without it, by adding its path inside Immich's code to the end of the `git diff` line, like
  `-- . ':!.vscode/settings.json'`, then run `git apply` again.

To see everything Memento changes in Immich's code: `git diff --stat "immich-$OLD" HEAD:immich`.

This was tried from v3.4.1 to v3.4.2, where nothing conflicted. A bigger release will have
conflicts to fix by hand.

### 3. Set the new version

1. See whether Immich's compose file changed: `git diff "immich-$OLD" "immich-$NEW" -- docker/docker-compose.yml`.
   If services or folders were renamed, check that Memento's changes on top of it still fit:
   `host/roles/immich/templates/docker-compose.override.yml.j2` (prod) and `deploy/dev/immich.yml`
   (dev).
2. In `host/roles/immich/defaults/main.yml`:
   - `immich_version`: the new version, like `v3.5.0`.
   - `immich_compose_sha256`: the fingerprint of Immich's compose file. These two must print the
     same; dev checks the first, prod the file it downloads:
     ```
     shasum -a 256 immich/docker/docker-compose.yml
     curl -sL https://github.com/immich-app/immich/releases/download/$NEW/docker-compose.yml | shasum -a 256
     ```
3. Check `immich/` really is the new release. This must print the new version without its `v`
   (`3.5.0`); the website and app builds stop otherwise:
   `sed -n 's/^  "version": "\(.*\)",$/\1/p' immich/server/package.json | head -n 1`
4. Delete the two tags; they were only for the patch: `git tag -d "immich-$OLD" "immich-$NEW"`.

### 4. Test in dev

```
./memento dev up                              # your dev data: tests Immich's database update
./memento dev reset && ./memento dev up       # and from nothing
```

- Try what Memento adds: AI Edit (the free fake), Adjust, Ask, live albums,
  `./memento dev sample-memories`, and Administration → Settings → Memento Features.
- Try the website as prod serves it: `apps/web/build.sh`, then `DEV_WEB=dist ./memento dev up`.
- Memento's service talks to Immich's API (`memento-extras/src/clients/immich.client.ts`). If the
  release notes change any of the calls it makes, check those features closely.

Then commit: `git add immich host/roles/immich/defaults/main.yml` (and any file you fixed), and
`git commit`.

### 5. Deploy, then check

```
apps/web/build.sh             # the website for the new version (dry-run needs it)
./memento prod dry-run        # Immich's new version should show up as a change
./memento prod deploy         # Immich pulls its new images and restarts; deploy waits until it's healthy
./memento android             # then install the new app on each phone
```

Update the phones soon: Immich's app warns when the server is a different version.

After it:

- The site opens, you can log in, the timeline, search and videos work.
- `curl -s https://photos.example.com/api/server/ping` answers `{"res":"pong"}`, and
  `curl -s https://photos.example.com/extras/health` answers `{"ok":true}`.
- Memento's features work: the AI Edit and Adjust buttons, Ask, live albums, and Administration →
  Settings → Memento Features.
- Administration → Job Queues: nothing piling up or failing.
- The app logs in, and its backup uploads new photos.
- The next morning: the backup ended "All copies done", and the night captions ran
  (`journalctl -u caption-night --since yesterday | tail -1`).

## Going back

Fixing forward is usually easier. If you must go back:

- **Immich:** it can't run on a database a newer version has updated. Put the old code back
  (`git revert`, or check out the commit before), restore the database copy from before the
  upgrade (Immich's guide: docs.immich.app → Administration → Backup and Restore; in Memento,
  Immich's folder is `/opt/immich`), then `./memento prod deploy`. What changed since is lost.
- **Memento:** an older version refuses a database a newer one has updated. Put the old code back,
  then on the server put the copy you set aside back, and deploy:
  ```
  cd /opt/memento-extras && sudo docker compose down
  sudo rm -f /opt/memento-extras/data/data.db-wal /opt/memento-extras/data/data.db-shm
  sudo cp /opt/memento-extras/memento-extras-before-upgrade.db /opt/memento-extras/data/data.db
  sudo chown 10001:10001 /opt/memento-extras/data/data.db
  ```
  Then `./memento prod deploy` on your computer.

## Everything else

- **Ubuntu, Docker and Caddy** update themselves every night at 22:30, but Docker and Caddy only
  within their major versions. A new major version waits until you change
  `docker_major_versions` (`host/roles/docker/defaults/main.yml`) or Caddy's pin
  (`host/roles/caddy/tasks/main.yml`), then deploy, in the daytime.
- **A new Linux kernel** needs a reboot, by hand: `ls /var/run/reboot-required && sudo reboot`.
- **The models** (the night captions' and Ask's) and **rclone** are pinned to exact versions and
  checked by fingerprint: `host/roles/memento_extras/defaults/main.yml` and
  `host/roles/backup/defaults/main.yml`. They change only when you change them.
