#!/usr/bin/env bash
# Builds Immich's web app WITH Memento's changes, using Immich's own build image in
# Docker (so your Mac's Node/pnpm versions don't matter).
#
#   Source: ../../immich   (Immich's code with Memento's changes, in this repo)
#   Output: dist/<immich version>/            the web app (static files)
#           dist/<immich version>.build.json  which release and commit it came from
#
# Usage: apps/web/build.sh
#        WEB_BUILD_DIR=/some/folder apps/web/build.sh   (build into another folder than dist/)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
src="$repo/immich"
dist="${WEB_BUILD_DIR:-$here/dist}"

version="$(sed -n 's/^immich_version: *//p' "$repo/host/roles/immich/defaults/main.yml")"
code_version="v$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$src/server/package.json" | head -n 1)"
if [ -z "$version" ] || [ "$version" != "$code_version" ]; then
  echo "immich/ is Immich $code_version, but immich_version in host/roles/immich/defaults/main.yml is '$version'." >&2
  exit 1
fi
commit="$(git -C "$repo" rev-parse --short HEAD)"
if [ -n "$(git -C "$repo" status --porcelain -- immich)" ]; then
  commit="$commit-uncommitted"
fi

# Memento branding for the UI texts (all languages), only for this build.
cid=""
i18n_copy="$(mktemp -d)"
cp -R "$src/i18n/." "$i18n_copy/"
cleanup() {
  rm -rf "$src/i18n" && mkdir "$src/i18n" && cp -R "$i18n_copy/." "$src/i18n/" && rm -rf "$i18n_copy"
  if [ -n "$cid" ]; then docker rm -f "$cid" >/dev/null; fi
}
trap cleanup EXIT
python3 -I "$here/../brand/rebrand-i18n.py" "$src"

image="selfphotos/immich-web-build:$version"
docker build --target web -f "$src/server/Dockerfile" --build-arg "BUILD_ID=selfphotos-memento-$commit" -t "$image" "$src"

out="$dist/$version"
mkdir -p "$out"
find "$out" -mindepth 1 -delete
cid="$(docker create "$image")"
docker cp "$cid:/usr/src/app/web/build/." "$out/"

cat > "$dist/$version.build.json" <<EOF
{
  "immichVersion": "$version",
  "commit": "$commit",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "Built Immich web $version ($commit) into $out ($(find "$out" -type f | wc -l | tr -d ' ') files)"
