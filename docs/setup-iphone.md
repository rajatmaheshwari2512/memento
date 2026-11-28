# Build the iPhone app (from source)

There's no iPhone app to download: you build it on a Mac and put it on your iPhone with a cable.
It's the same app as on Android, called Memento, with its own icon and your own app ID. A free
Apple ID is enough, with the limits [below](#a-free-apple-id).

This guide is for a person and for an AI agent. Steps marked **MANUAL** need a person. You also
need a Memento server to log in to: dev ([setup-dev.md](setup-dev.md)) for the simulator, or prod
([setup-prod.md](setup-prod.md)) for an iPhone.

## The short version

```
# MANUAL, once: Xcode, CocoaPods and the build tools (below)
apps/ios/build.sh          # the simulator
apps/ios/build.sh device   # the plugged-in iPhone; needs the IPHONE part of .env
```

## What you need

1. **MANUAL:** a Mac. The build doesn't run on Linux or Windows.
2. **MANUAL:** Xcode, free, about 15 GB.
   - The App Store has the newest Xcode, which needs a recent macOS. If your Mac's macOS is
     older, update it, or download an older Xcode that your macOS supports from
     https://developer.apple.com/download/all (log in with your Apple ID).
   - Open Xcode once, accept its licence, and install the iOS simulator it offers.
   - If you have more than one Xcode, or the build says Xcode isn't selected:
     `sudo xcode-select -s /Applications/Xcode.app`.
3. **MANUAL, once: the build tools.** From the top of the repo:
   ```
   brew install mise cocoapods
   cd immich && mise trust mise.toml mobile/mise.toml native/mise.toml
   cd mobile && mise install aqua:flutter/flutter java rust
   cd .. && mise install node pnpm npm:@openapitools/openapi-generator-cli
   cd native && mise install rust
   ```
   These are the versions Immich pins. The steps are also at the top of `apps/ios/build.sh`.
   - If Flutter was already installed (for example for the Android app), run
     `mise install --force aqua:flutter/flutter` once, in `immich/mobile`, so Immich's patch for
     simulator builds is applied.

## In the simulator

1. Start dev: `./memento dev up` ([setup-dev.md](setup-dev.md)).
2. `apps/ios/build.sh` builds the app for the simulator. It needs nothing in `.env`, and no
   Apple ID. At the end it prints three commands that open the simulator, install the app and
   open it.
3. **MANUAL:** in the app, enter the server address `http://localhost:8091` (the simulator
   reaches your Mac directly), then the test admin's email, `admin@local.test`, and its password,
   from `.local/dev/seed/credentials.env`.

## On an iPhone

1. **MANUAL:** add your Apple ID to Xcode: Xcode → Settings → Apple Accounts → +. A free Apple
   ID gets a "Personal Team".
2. **MANUAL:** find the team's ID, 10 letters and digits. In Xcode → Settings → Apple Accounts,
   pick the team → Manage Certificates → + → Apple Development (once). Then in Terminal:
   ```
   security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject
   ```
   The ID is the part after `OU=`.
3. Fill in the IPHONE part of `.env` (`cp .env.example .env` if there's no `.env` yet):
   - `MEMENTO_IOS_BUNDLE_ID`: the app's ID, your own and unique, like `xyz.yourname.memento`.
     Don't change it later: a new ID is a new app, logged out and with nothing backed up.
   - `MEMENTO_IOS_TEAM_ID`: the ID from step 2.
   - `MEMENTO_IOS_FREE_SIGNING=1` with a free Apple ID; empty with a paid Apple Developer account.

   Don't set the team in Xcode's Signing & Capabilities tab: that changes the project's files.
   The build script writes these into `immich/mobile/ios/Signing.local.xcconfig` (never committed).
4. **MANUAL:** plug in the iPhone, unlock it and tap **Trust** on it. On iOS 16 or later, turn on
   Settings → Privacy & Security → Developer Mode; the iPhone restarts.
5. `apps/ios/build.sh device` builds the app, installs it on the iPhone and opens it. If more than
   one device is connected, it asks which one. When the app is open, press `q` in the terminal:
   the app stays on the iPhone.
6. **MANUAL, the first time:** the iPhone refuses to open an app from an unknown developer. Go to
   Settings → General → VPN & Device Management → your Apple ID → Trust, then open Memento.
7. **MANUAL:** in the app, enter the server address `https://photos.example.com`, then your email
   and password. Turn on backup to upload the phone's photos.

To update the app, run `apps/ios/build.sh device` again: it installs over the old one and keeps
its data.

## A free Apple ID

A free Apple ID can put Memento on your own iPhone, with these limits:

- **The app stops opening after 7 days.** Plug the iPhone in and run `apps/ios/build.sh device`
  again; the app keeps its data and login.
- **At most 3 apps you built yourself** can be on one iPhone at a time.
- **About 10 new app IDs a week.** Memento uses three (the app, its widget and its Share menu
  entry), so pick `MEMENTO_IOS_BUNDLE_ID` once and keep it.
- **No Wi-Fi-name server switching.** Free signing leaves out Wi-Fi info, so the app always uses
  the server address you entered and ignores the "use this address on my home Wi-Fi" setting.

A paid Apple Developer account ($99 a year) has none of these limits.

## How iPhone differs from Android

- **Storage saver** works the same way, with iPhone formats:
  - HEIC photos stay HEIC.
  - Live Photos (on by default) and portrait photos stay full size. HDR HEIC photos (most iPhone photos) are shrunk and stay HDR.
  - HDR videos (iPhones record Dolby Vision HDR by default) are shrunk like other videos and stay HDR, Dolby Vision included.
  - iOS doesn't let background uploads shrink anything, so items to be shrunk wait until the app is open, or for iOS's longer overnight run.
  - Free up space shows no size when smaller copies are involved, because iOS has no public way to read a photo's file size.
- **Links to my.immich.app** don't open the app. Links that start with `immich://` do.
- **Passkeys and password autofill** tied to my.immich.app don't apply to the app.
- **Push notifications:** the app shows only its own notifications on the phone, as on Android.
