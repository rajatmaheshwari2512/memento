#!/usr/bin/env bash
# Serves the web app built by build.sh at http://localhost:8080 (Chrome recommended:
# it keeps the login cookie on plain-http localhost; Safari may not). Ctrl-C stops it.
#
# Your real Immich and extras service answer /api and /extras, so this is real data:
# saving an edit here saves it in your real library.
#
# Usage: apps/web/preview.sh [immich version]   (default: the newest build in dist/)
#        UPSTREAM=photos.example.com apps/web/preview.sh   (default: MEMENTO_DOMAIN from .env)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
version="${1:-$(find "$here/dist" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort -V | tail -1)}"
if [ -z "$version" ] || [ ! -f "$here/dist/$version/index.html" ]; then
  echo "No build found in $here/dist. Run build.sh first." >&2
  exit 1
fi

upstream="${UPSTREAM:-${MEMENTO_DOMAIN:-}}"
if [ -z "$upstream" ] && [ -f "$here/../../.env" ]; then
  upstream="$(sed -n 's/^[[:space:]]*MEMENTO_DOMAIN=//p' "$here/../../.env" | tail -n 1 |
    sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
fi
if [ -z "$upstream" ]; then
  echo "Set MEMENTO_DOMAIN in .env (or UPSTREAM) to your server's address, like photos.example.com." >&2
  exit 1
fi
echo "Previewing Immich web $version at http://localhost:8080 (API: https://$upstream). Ctrl-C to stop."
exec docker run --rm --name selfphotos-web-preview \
  -p 127.0.0.1:8080:8080 \
  -e "UPSTREAM=$upstream" \
  -v "$here/dist/$version:/srv:ro" \
  -v "$here/Caddyfile.preview:/etc/caddy/Caddyfile:ro" \
  caddy:2.11.7-alpine
