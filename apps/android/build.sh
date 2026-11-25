#!/usr/bin/env bash
# Builds the Immich Android app WITH our AI edit changes: "Immich AI"
# (app.alextran.immich.selfphotos), which installs next to the official Play Store app.
#
#   Source: ../../immich   (Immich's code with Memento's changes, in this repo)
#   Output: dist/memento-<immich version>-<commit>.apk   (arm64 phones)
#
# Follows Immich's own CI (.github/workflows/build-mobile.yml): install, codegen,
# `flutter build apk --release`, running Immich's mise tasks by name. Two tasks are
# skipped: install:ios (CocoaPods, iOS only) and //:i18n:format-fix (re-formats the
# whole repo with prettier; not needed to build).
#
# One-time setup:
#   - tools at the versions Immich pins, installed with mise from inside the repo so its
#     lock files decide the exact builds (no other tools from Immich's config):
#       cd immich && mise trust mise.toml mobile/mise.toml native/mise.toml
#       cd mobile && mise install aqua:flutter/flutter java rust
#       cd .. && mise install node pnpm npm:@openapitools/openapi-generator-cli
#       cd native && mise install rust
#   - brew install --cask android-commandlinetools, and its licenses accepted
#   - the signing key in ~/.config/selfphotos/android/ and its password in .env (ANDROID_KEYSTORE_PASSWORD)
#
# Usage: apps/android/build.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
src="$repo/immich"
keystore="$HOME/.config/selfphotos/android/selfphotos-immich.jks"

cd "$src"
version="$(sed -n 's/^immich_version: *//p' "$repo/host/roles/immich/defaults/main.yml")"
code_version="v$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$src/server/package.json" | head -n 1)"
if [ -z "$version" ] || [ "$version" != "$code_version" ]; then
  echo "immich/ is Immich $code_version, but immich_version in host/roles/immich/defaults/main.yml is '$version'." >&2
  exit 1
fi
commit="$(git -C "$repo" rev-parse --short HEAD)"
if [ -n "$(git -C "$repo" status --porcelain -- immich/mobile/lib immich/mobile/android immich/mobile/pubspec.yaml)" ]; then
  commit="$commit-uncommitted"
fi

if [ ! -f "$keystore" ]; then
  echo "No signing key at $keystore (see the one-time setup at the top of this script)." >&2
  exit 1
fi
password=""
if [ -f "$repo/.env" ]; then
  password="$(sed -n 's/^[[:space:]]*ANDROID_KEYSTORE_PASSWORD=//p' "$repo/.env" | tail -n 1 |
    sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
fi
if [ -z "$password" ]; then
  echo "ANDROID_KEYSTORE_PASSWORD is missing from .env." >&2
  exit 1
fi

# Never let mise install the other tools Immich's config lists (ffmpeg, OpenTofu, ...).
export MISE_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false
# Immich's "//mobile:task" names use mise's monorepo feature, still marked experimental.
export MISE_EXPERIMENTAL=1
export MISE_YES=1
export ANDROID_HOME="${ANDROID_HOME:-$(brew --prefix)/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# The release build signs with android/key.jks if it exists (Immich's build.gradle).
saved="$(mktemp -d)"
mkdir -p "$saved/mobile" "$saved/native" "$saved/i18n"
cp mise.lock "$saved/mise.lock"
cp mobile/mise.lock "$saved/mobile/mise.lock"
cp native/mise.lock "$saved/native/mise.lock"
cp -R i18n/. "$saved/i18n/"
restore() {
  rm -f "$src/mobile/android/key.jks"
  cp "$saved/mise.lock" "$src/mise.lock"
  cp "$saved/mobile/mise.lock" "$src/mobile/mise.lock"
  cp "$saved/native/mise.lock" "$src/native/mise.lock"
  rm -rf "$src/i18n" && mkdir "$src/i18n" && cp -R "$saved/i18n/." "$src/i18n/" && rm -rf "$saved"
}
trap restore EXIT
cp "$keystore" mobile/android/key.jks
export ALIAS=selfphotos ANDROID_KEY_PASSWORD="$password" ANDROID_STORE_PASSWORD="$password"

# Memento branding for the UI texts (all languages), only for this build: codegen turns
# them into Dart code below, then the trap restores Immich's own translation files.
python3 -I "$here/../brand/rebrand-i18n.py" "$src"

echo "== Generating the API client"
mise run //:open-api-dart

echo "== Installing Flutter packages"
cd "$src/mobile"
mise exec -- flutter pub get --enforce-lockfile
mise run //mobile:install:build-runner-patch

echo "== Generating code"
mise run //mobile:codegen:drift:migration
mise run //mobile:codegen:dart
mise run //mobile:codegen:native
mise run //mobile:codegen:pigeon
mise run //mobile:i18n:loader
mise run //mobile:i18n:keys

echo "== Making sure Gradle itself is downloaded"
# Gradle's launcher downloads Gradle from GitHub and sticks to the first address it gets;
# one of GitHub's download addresses doesn't answer from this network, so it can hang and
# fail. curl tries the other addresses, so fetch it with curl into the folder the launcher
# looks in (named from an MD5 of the URL, in base 36), checked against Gradle's checksum.
dist_url="$(sed -n 's/^distributionUrl=//p' android/gradle/wrapper/gradle-wrapper.properties | sed 's/\\:/:/g')"
dist_name="$(basename "$dist_url" .zip)"
dist_hash="$(python3 -I -c 'import hashlib,sys
n = int.from_bytes(hashlib.md5(sys.argv[1].encode()).digest(), "big"); s = ""
while n: n, r = divmod(n, 36); s = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + s
print(s)' "$dist_url")"
dist_dir="$HOME/.gradle/wrapper/dists/$dist_name/$dist_hash"
if [ ! -f "$dist_dir/$dist_name.zip.ok" ] && [ ! -f "$dist_dir/$dist_name.zip" ]; then
  mkdir -p "$dist_dir"
  curl -fL --retry 3 -o "$dist_dir/$dist_name.zip.tmp" "$dist_url"
  expected="$(curl -fsL "$dist_url.sha256")"
  actual="$(shasum -a 256 "$dist_dir/$dist_name.zip.tmp" | cut -d' ' -f1)"
  if [ "$expected" != "$actual" ]; then
    echo "Gradle download doesn't match its published checksum." >&2
    rm -f "$dist_dir/$dist_name.zip.tmp"
    exit 1
  fi
  mv "$dist_dir/$dist_name.zip.tmp" "$dist_dir/$dist_name.zip"
  rm -f "$dist_dir/$dist_name.zip.part"
fi

echo "== Building the APK"
mise exec -- flutter build apk --release --target-platform android-arm64 --split-per-abi

mkdir -p "$here/dist"
out="$here/dist/memento-$version-$commit.apk"
cp build/app/outputs/flutter-apk/app-arm64-v8a-release.apk "$out"
echo "Built $out ($(du -h "$out" | cut -f1))"
