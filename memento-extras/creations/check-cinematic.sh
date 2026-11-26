#!/bin/sh
# A check after a deploy: renders one cinematic photo on the server through the running creations
# container and prints the outcome, how long it took, and the container's memory peak.
# Run from the repository on the Mac:
#
#   ssh ubuntu@photos.example.com 'sudo sh -s' < memento-extras/creations/check-cinematic.sh
#   ssh ubuntu@photos.example.com 'sudo sh -s -- /path/to/photo.jpg' < memento-extras/creations/check-cinematic.sh
#
# Without a photo it takes the newest preview Immich made. A photo with no clear subject answers
# "unsuitable", which also means the container works. If it is busy, try again in a minute.
set -eu
WORK=/opt/memento-extras/creations-work
PHOTO=${1:-$(find /opt/immich/thumbs -name '*_preview.jpeg' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)}
[ -f "$PHOTO" ] || { echo "no photo to try ($PHOTO)"; exit 1; }
ID=$(cat /proc/sys/kernel/random/uuid)
DIR="$WORK/$ID"
SAMPLES=$(mktemp)
STATS=""
cleanup() {
  [ -n "$STATS" ] && kill "$STATS" 2>/dev/null || true
  rm -rf "$DIR" "$SAMPLES"
}
trap cleanup EXIT INT TERM
install -d -o 10001 -g 10001 -m 0700 "$DIR"
install -o 10001 -g 10001 -m 0600 "$PHOTO" "$DIR/0.jpg"

(while :; do docker stats --no-stream --format '{{.MemUsage}}' memento_creations | cut -d/ -f1; sleep 0.5; done) >"$SAMPLES" 2>/dev/null &
STATS=$!

echo "rendering a cinematic photo from $PHOTO ..."
STATUS=0
docker exec memento_extras node --input-type=module -e '
const id = process.argv[1];
const base = process.env.CREATIONS_URL || "http://memento-creations:8000";
const job = { id, kind: "cinematic", photo: { file: "0.jpg", faces: [] }, stamp: { local: "2026-01-01T12:00:00", offset: "+00:00", gps: null } };
const started = Date.now();
const res = await fetch(`${base}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
if (res.status !== 202) {
  console.log(res.status === 429 ? "the container is busy with a real job: try again in a minute" : `not started (${res.status}): ${await res.text()}`);
  process.exit(1);
}
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const state = await (await fetch(`${base}/renders/${id}`)).json();
  if (state.state === "running" && Date.now() - started < 300000) continue;
  console.log(JSON.stringify({ ...state, seconds: Math.round((Date.now() - started) / 100) / 10 }));
  process.exit(state.state === "done" || state.state === "unsuitable" ? 0 : 1);
}' "$ID" </dev/null || STATUS=$?

kill "$STATS" 2>/dev/null || true
STATS=""
awk '{ v = $1 + 0; if ($1 ~ /GiB/) v *= 1024; else if ($1 ~ /KiB/) v /= 1024; else if ($1 ~ /[0-9]B$/) v /= 1048576; if (v > max) max = v }
  END { if (max > 0) printf "memento_creations memory peak while rendering: %.0f MiB (its cap is 1 GiB)\n", max; else print "memento_creations memory: over before docker stats could sample it" }' "$SAMPLES"
exit "$STATUS"
