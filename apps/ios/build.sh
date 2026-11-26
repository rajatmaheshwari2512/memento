#!/usr/bin/env bash
# Builds the Memento iPhone app from source: for the iOS simulator, or onto a plugged-in iPhone.
# The full guide is docs/setup-iphone.md.
#
#   Source: ../../immich   (Immich's code with Memento's changes, in this repo)
#
# One-time setup:
#   - a Mac with Xcode, opened once, its licence accepted and its iOS simulator installed
#   - CocoaPods: brew install cocoapods
#   - tools at the versions Immich pins, installed with mise from inside the repo so its
#     lock files decide the exact builds (no other tools from Immich's config):
#       cd immich && for f in mise.toml mobile/mise.toml native/mise.toml; do mise trust "$f"; done
#       cd mobile && mise install aqua:flutter/flutter java rust
#       cd .. && mise install node pnpm npm:@openapitools/openapi-generator-cli
#       cd native && mise install rust
#   - for an iPhone: your Apple ID in Xcode (Settings → Apple Accounts), and
#     MEMENTO_IOS_BUNDLE_ID, MEMENTO_IOS_TEAM_ID and MEMENTO_IOS_FREE_SIGNING in .env
#
# Usage: apps/ios/build.sh           builds for the simulator and says how to open it there
#        apps/ios/build.sh device    builds for the plugged-in iPhone, installs and opens it
#        MEMENTO_ENV_FILE=/path/to/file apps/ios/build.sh   (settings from another file than .env)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
src="$repo/immich"
env_file="${MEMENTO_ENV_FILE:-$repo/.env}"
. "$repo/apps/mobile-build.sh"

target="${1:-simulator}"
case "$target" in
  simulator | device) ;;
  *)
    echo "Usage: apps/ios/build.sh [device]" >&2
    exit 1
    ;;
esac

if [ "$(uname)" != Darwin ] || ! xcodebuild -version >/dev/null 2>&1; then
  echo "The iPhone app builds only on a Mac with Xcode (docs/setup-iphone.md). If Xcode is installed," >&2
  echo "select it: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi
if ! command -v pod >/dev/null; then
  echo "CocoaPods is missing: brew install cocoapods" >&2
  exit 1
fi

bundle_id="$(env_value MEMENTO_IOS_BUNDLE_ID)"
team_id="$(env_value MEMENTO_IOS_TEAM_ID)"
free_signing="$(env_value MEMENTO_IOS_FREE_SIGNING)"
case "$bundle_id" in *[!A-Za-z0-9.-]*)
  echo "MEMENTO_IOS_BUNDLE_ID may have only letters, digits, dots and hyphens, like xyz.yourname.memento." >&2
  exit 1
  ;;
esac
if [ "$target" = device ] && { [ -z "$bundle_id" ] || [ -z "$team_id" ]; }; then
  echo "Installing on an iPhone needs MEMENTO_IOS_BUNDLE_ID and MEMENTO_IOS_TEAM_ID in $env_file" >&2
  echo "(docs/setup-iphone.md)." >&2
  exit 1
fi

# The app ID, team and entitlements, through Immich's own override of ios/Signing.xcconfig.
if [ -n "$bundle_id" ]; then
  {
    echo "// Written by apps/ios/build.sh from MEMENTO_IOS_* in .env, on each build."
    if [ -n "$team_id" ]; then echo "IMMICH_TEAM_ID = $team_id"; fi
    echo "IMMICH_BUNDLE_ID_PROD = $bundle_id"
    echo "IMMICH_BUNDLE_ID_DEV = $bundle_id"
    echo "IMMICH_GROUP_ID = group.$bundle_id"
    if [ "$free_signing" = 1 ]; then
      echo "MEMENTO_RUNNER_ENTITLEMENTS = Runner/RunnerFreeSigning.entitlements"
    fi
  } > "$src/mobile/ios/Signing.local.xcconfig"
fi

save_build_inputs
trap restore_build_inputs EXIT

generate_code

echo "== Installing CocoaPods packages"
mise run //mobile:install:ios

if [ "$target" = device ]; then
  echo "== Building for the iPhone, installing and opening it"
  echo "(when it's open, press q here: the app stays on the iPhone)"
  mise exec -- flutter run --release
  exit 0
fi

echo "== Building for the simulator"
mise exec -- flutter build ios --simulator --debug
set -- build/ios/iphonesimulator/*.app
app="$(cd "$1" && pwd)"
app_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
echo "Built $app"
echo "To open it in the simulator:"
echo "  open -a Simulator"
echo "  xcrun simctl install booted '$app'"
echo "  xcrun simctl launch booted $app_id"
