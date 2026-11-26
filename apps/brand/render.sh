#!/usr/bin/env bash
# Renders every Memento image (web app + Android app) from the SVGs in this folder, and
# puts them into ../../immich under the file names Immich already uses (plus a few
# new ones for dark mode). Uses only macOS's built-in sips, which renders SVG with a
# transparent background. Run after changing an SVG here, then rebuild.
#
# The mark: a photo frame whose two peaks spell M, and a small sun, in one colour:
#   memento-mark-light.svg   black, for light mode      memento-mark-dark.svg   white, for dark mode
#   memento-mark-auto.svg    browser tab: black, white when the system is in dark mode
#   memento-home-*.svg       home-screen tiles (they need a background): white / near-black
#   memento-inline-*, memento-stacked-*, memento-wordmark-*   with the name, light / dark
#   memento-splash-android12-*.svg   Android 12+ splash (Android shows the middle as a circle)
#   memento-glyph-white.svg  notification icon (Android always draws it as a white silhouette)
#
# Usage: apps/brand/render.sh
set -euo pipefail

brand="$(cd "$(dirname "$0")" && pwd)"
src="$(cd "$brand/../../immich" && pwd)"
web="$src/web"
mobile="$src/mobile"
res="$mobile/android/app/src/main/res"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# render <svg> <width> <height> <out.png>: renders an SVG at that size, background transparent.
render() {
  python3 -I - "$1" "$2" "$3" "$tmp/in.svg" <<'PY'
import re, sys
src, w, h, out = sys.argv[1:]
svg = open(src).read()
tag = re.search(r"<svg\b[^>]*>", svg).group(0)
new = re.sub(r'\s(width|height)="[^"]*"', "", tag).replace("<svg", f'<svg width="{w}" height="{h}"', 1)
open(out, "w").write(svg.replace(tag, new, 1))
PY
  sips -s format png "$tmp/in.svg" --out "$4" >/dev/null
}
resize() { sips -z "$2" "$2" "$1" --out "$3" >/dev/null; }

for t in light dark; do
  render "$brand/memento-mark-$t.svg" 1024 1024 "$tmp/mark-$t.png"
  render "$brand/memento-home-$t.svg" 1024 1024 "$tmp/home-$t.png"
  render "$brand/memento-splash-android12-$t.svg" 1152 1152 "$tmp/splash12-$t.png"
  render "$brand/memento-wordmark-$t.svg" 1600 400 "$tmp/wordmark-$t.png"
  render "$brand/memento-inline-$t.svg" 1400 400 "$tmp/inline-$t.png"
done
render "$brand/memento-glyph-white.svg" 1024 1024 "$tmp/glyph.png"

# --- web app (web/static, web/src/lib/assets/memento) ---
cp "$brand"/memento-{mark-light,mark-dark,inline-light,inline-dark,stacked-light,stacked-dark}.svg "$web/src/lib/assets/memento/"
cp "$brand/memento-mark-auto.svg" "$web/static/icon.svg"
resize "$tmp/home-light.png" 180 "$web/static/apple-icon-180.png"
resize "$tmp/home-light.png" 192 "$web/static/manifest-icon-192.maskable.png"
resize "$tmp/home-light.png" 512 "$web/static/manifest-icon-512.maskable.png"
for s in 16 32 48; do resize "$tmp/mark-light.png" "$s" "$tmp/fav-$s.png"; done
python3 -I - "$web/static/favicon.ico" "$tmp"/fav-{16,32,48}.png <<'EOF'
import struct, sys
out, files = sys.argv[1], sys.argv[2:]
imgs = [open(f, "rb").read() for f in files]
entries, blobs, offset = b"", b"", 6 + 16 * len(imgs)
for size, data in zip((16, 32, 48), imgs):
    entries += struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
    blobs += data
open(out, "wb").write(struct.pack("<HHH", 0, 1, len(imgs)) + entries + blobs)
EOF

# --- Android app: images used inside the app (mobile/assets) ---
cp "$tmp/mark-light.png" "$mobile/assets/immich-logo.png"          # light mode (and the default)
cp "$tmp/mark-dark.png" "$mobile/assets/memento-logo-dark.png"     # dark mode (new)
for t in light dark; do
  cp "$tmp/inline-$t.png" "$mobile/assets/immich-logo-inline-$t.png"
  cp "$tmp/wordmark-$t.png" "$mobile/assets/immich-text-$t.png"
done
cp "$tmp/home-light.png" "$mobile/assets/immich-logo-w-bg.png"
resize "$tmp/home-light.png" 3072 "$mobile/assets/immich-logo-w-bg-android.png"
resize "$tmp/home-light.png" 324 "$mobile/assets/immich-logo-android-adaptive-icon.png"
resize "$tmp/mark-light.png" 320 "$mobile/assets/immich-splash.png"
cp "$tmp/splash12-light.png" "$mobile/assets/immich-splash-android12.png"

# --- Android app: launcher icon fallbacks, splash screens, notification icon ---
for pair in mdpi:48:80:288:24 hdpi:72:120:432:36 xhdpi:96:160:576:48 xxhdpi:144:240:864:72 xxxhdpi:192:320:1152:96; do
  IFS=: read -r d launcher splash splash12 notify <<<"$pair"
  resize "$tmp/home-light.png" "$launcher" "$res/mipmap-$d/ic_launcher.png"
  resize "$tmp/mark-light.png" "$splash" "$res/drawable-$d/splash.png"
  resize "$tmp/mark-dark.png" "$splash" "$res/drawable-night-$d/splash.png"
  resize "$tmp/splash12-light.png" "$splash12" "$res/drawable-$d/android12splash.png"
  resize "$tmp/splash12-dark.png" "$splash12" "$res/drawable-night-$d/android12splash.png"
  resize "$tmp/glyph.png" "$notify" "$res/drawable-$d/notification_icon.png"
done

echo "Rendered Memento images into $src (web/static, web/src/lib/assets/memento, mobile/assets, android res)."
