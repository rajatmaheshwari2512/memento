#!/usr/bin/env bash
# Builds the Immich Android app WITH our AI edit changes: "Immich AI"
# (app.alextran.immich.selfphotos), which installs next to the official Play Store app.
#
#   Source: ../../immich   (Immich's code with Memento's changes, in this repo)
#   Output: dist/memento-<immich version>-<commit>.apk   (arm64 phones)
#
#
# One-time setup:
#   - tools at the versions Immich pins, installed with mise from inside the repo so its
#     lock files decide the exact builds (no other tools from Immich's config):
#       cd immich && for f in mise.toml mobile/mise.toml native/mise.toml; do mise trust "$f"; done
#       cd mobile && mise install aqua:flutter/flutter java rust
#       cd .. && mise install node pnpm npm:@openapitools/openapi-generator-cli
#       cd native && mise install rust
#   - brew install --cask android-commandlinetools, and its licenses accepted
#   - the signing key and its password: ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_ALIAS and
#     ANDROID_KEYSTORE_PASSWORD in .env (./memento android keystore makes one)
#
# Usage: apps/android/build.sh   (or ./memento android)
#        MEMENTO_ENV_FILE=/path/to/file apps/android/build.sh   (settings from another file than .env)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
src="$repo/immich"
env_file="${MEMENTO_ENV_FILE:-$repo/.env}"
. "$repo/apps/mobile-build.sh"
keystore="$(env_value ANDROID_KEYSTORE_PATH)"
keystore="${keystore:-$HOME/.config/memento/android/memento.jks}"
case "$keystore" in "~"/*) keystore="$HOME/${keystore#"~/"}" ;; /*) ;; *) keystore="$repo/$keystore" ;; esac
key_alias="$(env_value ANDROID_KEYSTORE_ALIAS)"
key_alias="${key_alias:-memento}"

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
  echo "No signing key at $keystore (./memento android keystore makes one)." >&2
  exit 1
fi
password="$(env_value ANDROID_KEYSTORE_PASSWORD)"
if [ -z "$password" ]; then
  echo "ANDROID_KEYSTORE_PASSWORD is missing from $env_file." >&2
  exit 1
fi

export ANDROID_HOME="${ANDROID_HOME:-$(brew --prefix)/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

save_build_inputs
restore() {
  rm -f "$src/mobile/android/key.jks"
  restore_build_inputs
}
trap restore EXIT
cp "$keystore" mobile/android/key.jks
export ALIAS="$key_alias" ANDROID_KEY_PASSWORD="$password" ANDROID_STORE_PASSWORD="$password"

generate_code

echo "== Making sure Gradle itself is downloaded"
# Fetches Gradle with curl into the folder the launcher looks in.
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
