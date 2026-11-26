#!/bin/sh
# Reduce noise, end to end on the Mac: builds the creations image, makes test videos in each kind of file,
# runs the container as the server does, has it clean each one through its API and checks the picture, the
# sound, a video with no sound, a gap in the sound, a header that lies about the length, and a 10-minute video.
# Prints one line per check and exits 1 if any failed.
#
#   cd memento-extras && sh creations/check-reduce-noise.sh      # about 3 minutes
set -eu
cd "$(dirname "$0")"
IMAGE=memento-creations:check
NAME=reduce-noise-check
WORK=$(mktemp -d "${TMPDIR:-/tmp}/reduce-noise-check.XXXXXX")
SAMPLES=$(mktemp)
STATS=""
FAILED=0
cleanup() {
  [ -n "$STATS" ] && kill "$STATS" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK" "$SAMPLES"
}
trap cleanup EXIT INT TERM
mkdir -p "$WORK/media" "$WORK/work"

echo "== building $IMAGE"
docker build -q -t "$IMAGE" . >/dev/null

# Runs the shell script on stdin in a throwaway container of the image, with $WORK as /m.
tools() {
  cat > "$WORK/script.sh"
  docker run --rm --network none -v "$WORK:/m" -w /m --entrypoint sh "$IMAGE" /m/script.sh "$@"
}

echo "== making the test videos"
if command -v say >/dev/null 2>&1; then
  say -v Samantha -o "$WORK/media/speech.aiff" "Hello everyone, and welcome to our trip to the hills. We just reached the top, and the view from here is absolutely beautiful. The wind is very strong today, so I hope you can still hear me. Let's walk a little further down the trail and find a good spot for lunch."
fi
tools <<'EOF'
set -e
cd media
[ -f speech.aiff ] || ffmpeg -v error -f lavfi -i "aevalsrc='0.3*sin(2*PI*(170+50*sin(2*PI*0.7*t))*t)*(0.55+0.45*sin(2*PI*3*t))':s=48000:d=15" speech.aiff
ffmpeg -v error -y -i speech.aiff -i speech.aiff -f lavfi -i "anoisesrc=d=60:c=pink:r=48000:a=0.08" -f lavfi -i "sine=f=100:d=60:r=48000" \
  -filter_complex "[0:a]aresample=48000,adelay=10000,apad=whole_dur=60[s1];[1:a]aresample=48000,adelay=35000,apad=whole_dur=60[s2];[3:a]volume=0.05[h];[s1][s2][2:a][h]amix=inputs=4:normalize=0[a]" \
  -map "[a]" -t 60 -c:a pcm_s16le noisy.wav
# a.mp4: H.264 1080p, stereo AAC at 48 kHz, filmed sideways (rotation 90), with a date and place.
ffmpeg -v error -y -f lavfi -i "testsrc2=s=1920x1080:r=30:d=60" -i noisy.wav -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ac 2 -t 60 flat.mp4
ffmpeg -v error -y -display_rotation:v:0 90 -i flat.mp4 -map 0 -c copy -metadata creation_time=2026-10-20T08:30:00Z \
  -metadata "com.apple.quicktime.location.ISO6709=+15.4989+073.8278/" -movflags +use_metadata_tags a.mp4
rm flat.mp4
# b.mov: HEVC, mono AAC at 44.1 kHz whose sound starts half a second after the picture.
ffmpeg -v error -y -f lavfi -i "testsrc2=s=1280x720:r=30:d=20" -itsoffset 0.5 -i noisy.wav -map 0:v -map 1:a -c:v libx265 -preset ultrafast \
  -x265-params log-level=error -tag:v hvc1 -pix_fmt yuv420p -c:a aac -b:a 96k -ac 1 -ar 44100 -t 20 b.mov
# c.webm: VP9 with Opus. d.mkv: H.264 with AAC. e.3gp: H.264 with mono AAC.
ffmpeg -v error -y -f lavfi -i "testsrc2=s=640x360:r=25:d=20" -i noisy.wav -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 500k \
  -c:a libopus -b:a 96k -t 20 c.webm
ffmpeg -v error -y -f lavfi -i "testsrc2=s=640x360:r=25:d=20" -i noisy.wav -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -t 20 d.mkv
ffmpeg -v error -y -f lavfi -i "testsrc2=s=352x288:r=15:d=20" -i noisy.wav -c:v libx264 -preset veryfast -pix_fmt yuv420p -profile:v baseline \
  -c:a aac -ac 1 -b:a 64k -t 20 e.3gp
# f.mp4: no sound at all.
ffmpeg -v error -y -f lavfi -i "testsrc2=s=640x360:r=25:d=5" -c:v libx264 -preset veryfast -pix_fmt yuv420p f.mp4
# long.mp4: a.mp4 ten times over, 10 minutes.
ffmpeg -v error -y -stream_loop 9 -i a.mp4 -map 0 -c copy -t 600 long.mp4
# g.mkv: a 2 s gap in the sound's timestamps at 5 s.
ffmpeg -v error -y -f lavfi -i "testsrc2=s=320x240:r=25:d=20" -i noisy.wav -filter_complex "[1:a]atrim=0:18,asetpts='if(gte(T,5),PTS+2/TB,PTS)'[a]" \
  -map 0:v -map "[a]" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -t 20 g.mkv
echo "  g.mkv: the sound's packets jump $(ffprobe -v error -select_streams a:0 -show_entries packet=pts_time -of csv=p=0 g.mkv | awk 'NR > 1 && $1 - p > 0.5 { printf "%s -> %s s ", p, $1 } { p = $1 }')"
# h.mkv: 30 minutes of sound in a file whose header says it's 30 s long.
ffmpeg -v error -y -f lavfi -i "color=s=64x64:r=1:d=1800" -f lavfi -i "anoisesrc=d=1800:r=48000:a=0.1" -c:v libx264 -preset ultrafast \
  -c:a libopus -b:a 6k -ac 1 h.mkv
node -e '
const fs = require("fs");
const file = fs.readFileSync(process.argv[1]);
const at = file.indexOf(Buffer.from([0x44, 0x89, 0x88]));
if (at < 0) throw new Error("no Duration in h.mkv");
file.writeDoubleBE(30000, at + 3);
fs.writeFileSync(process.argv[1], file);' h.mkv
echo "  h.mkv: its header says $(ffprobe -v error -show_entries format=duration -of csv=p=0 h.mkv) s"
EOF

echo "== starting the container as the server runs it"
docker run -d --name "$NAME" --network none --read-only --tmpfs /tmp:size=64m --user 10001:10001 \
  --memory 1g --memory-swap 1g --cpus 1.5 --cpu-shares 2 --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$WORK/work:/work" "$IMAGE" >/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do
  docker exec "$NAME" node -e "fetch('http://127.0.0.1:8000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null && break
  sleep 1
done

# Cleans media/$1 (a .$2 file) through the container's API, as the job $JOB (new for each);
# prints its final state (JSON) and leaves the copy at work/$JOB/reduce-noise.video.
clean() {
  mkdir "$WORK/work/$JOB"
  cp "$WORK/media/$1" "$WORK/work/$JOB/video.$2"
  docker exec "$NAME" node --input-type=module -e '
const [id, format] = process.argv.slice(1);
const base = "http://127.0.0.1:8000";
const started = Date.now();
const res = await fetch(`${base}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, kind: "reduce-noise", video: `video.${format}`, format }) });
if (res.status !== 202) { console.log(JSON.stringify({ state: "not started", status: res.status, body: await res.text() })); process.exit(0); }
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = await (await fetch(`${base}/renders/${id}`)).json();
  if (state.state === "running") continue;
  console.log(JSON.stringify({ ...state, seconds: Math.round((Date.now() - started) / 100) / 10 }));
  break;
}' "$JOB" "$2"
}

pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
# Compares two numbers: `within a b tolerance` succeeds when |a - b| <= tolerance.
within() { awk -v a="$1" -v b="$2" -v t="$3" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d <= t) }'; }
below() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }

# The checks every copy gets; prints key=value lines for the caller's own checks.
facts() {
  tools "$1" "$2" <<'EOF'
set -e
orig=$1; copy=$2
pkts() { ffmpeg -v error -i "$1" -map 0:v:0 -c copy -f framecrc - | grep -v '^#'; }
pkts "$orig" > /tmp/a; pkts "$copy" > /tmp/b
cmp -s /tmp/a /tmp/b && echo "picture=same" || echo "picture=different"
echo "packets=$(wc -l < /tmp/a)"
probe() { ffprobe -v error -select_streams "$2" -show_entries "$3" -of default=nw=1:nk=1 "$1" | head -1; }
echo "family=$(ffprobe -v error -show_entries format=format_name -of default=nw=1:nk=1 "$copy")"
echo "tag=$(probe "$orig" v:0 stream=codec_tag_string) $(probe "$copy" v:0 stream=codec_tag_string)"
echo "codec=$(probe "$copy" a:0 stream=codec_name)"
echo "channels=$(probe "$orig" a:0 stream=channels) $(probe "$copy" a:0 stream=channels)"
echo "rate=$(probe "$orig" a:0 stream=sample_rate) $(probe "$copy" a:0 stream=sample_rate)"
echo "start=$(probe "$orig" a:0 stream=start_time) $(probe "$copy" a:0 stream=start_time)"
echo "length=$(probe "$orig" v:0 format=duration) $(probe "$copy" v:0 format=duration)"
echo "rotation=$(ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation -of default=nw=1:nk=1 "$copy" | head -1)"
tag() { ffprobe -v error -show_entries "format_tags=$2" -of default=nw=1:nk=1 "$1"; }
echo "place=$(tag "$orig" com.apple.quicktime.location.ISO6709)|$(tag "$copy" com.apple.quicktime.location.ISO6709)"
echo "date=$(tag "$orig" creation_time)|$(tag "$copy" creation_time)"
dec() { ffmpeg -nostdin -v error -y -i "$1" -map 0:a:0 -af "aresample=16000:async=1:first_pts=0" -ac 1 -f s16le "$2"; }
dec "$orig" /tmp/o.raw; dec "$copy" /tmp/c.raw
echo "shift=$(node -e '
const fs = require("fs");
const [a, b] = process.argv.slice(1).map((f) => { const d = fs.readFileSync(f); return new Int16Array(d.buffer, d.byteOffset, d.length >> 1); });
const rate = 16000, from = 11 * rate, length = 4 * rate, most = 0.1 * rate;
let best = -Infinity, shift = 0;
for (let lag = -most; lag <= most; lag++) {
  let sum = 0;
  for (let i = from; i < from + length; i++) sum += a[i] * (b[i + lag] ?? 0);
  if (sum > best) { best = sum; shift = lag; }
}
console.log((shift / rate * 1000).toFixed(1));' /tmp/o.raw /tmp/c.raw)"
rms() { ffmpeg -nostats -i "$1" -map 0:a:0 -af "atrim=$2:$3,astats=measure_overall=RMS_level:measure_perchannel=0" -f null - 2>&1 | awk '/RMS level dB/ { print $NF }'; }
for span in "1 9" "26 34" "51 59" "12 24" "37 49"; do
  set -- $span
  echo "rms_$1_$2=$(rms "$orig" "$1" "$2") $(rms "$copy" "$1" "$2")"
done
EOF
}

get() { printf '%s\n' "$FACTS" | sed -n "s/^$1=//p"; }

common_checks() { # $1: what it is, $2: expected family, $3: expected codec
  [ "$(get picture)" = same ] && pass "$1: the picture's $(get packets) packets and timestamps unchanged" || fail "$1: the picture changed"
  set -- "$1" "$2" "$3" $(get tag)
  [ "$4" = "$5" ] && pass "$1: the picture's codec tag kept ($5)" || fail "$1: the picture's codec tag changed ($4 → $5)"
  set -- "$1" "$2" "$3"
  case "$(get family)" in *"$2"*) pass "$1: $(get family) file, $(get codec) sound" ;; *) fail "$1: wrong kind of file ($(get family))" ;; esac
  [ "$(get codec)" = "$3" ] || fail "$1: the sound is $(get codec), not $3"
  set -- "$1" $(get channels) $(get rate) $(get start) $(get length)
  [ "$2" = "$3" ] && [ "$4" = "$5" ] && pass "$1: $3 channel(s) at $5 Hz, as the original" || fail "$1: channels or rate changed ($2→$3, $4→$5)"
  within "$6" "$7" 0.03 && pass "$1: the sound starts at $7 s ($6 s in the original)" || fail "$1: the sound moved ($6 → $7 s)"
  within "$(get shift)" 0 1 && pass "$1: in step with the picture (the speech $(get shift) ms off the original's)" || fail "$1: out of step by $(get shift) ms"
  within "$8" "$9" 0.1 && pass "$1: as long as the original ($8 s)" || fail "$1: length changed ($8 → $9 s)"
}

noise_checks() { # $1: what it is, then the spans to check: noise-only spans, then speech spans
  name=$1; shift
  for span in "$@"; do
    case $span in
      noise:*) set -- $(get "rms_${span#noise:}"); below "$2" "$(awk -v a="$1" 'BEGIN { print a - 10 }')" \
                 && pass "$name: noise alone ${span#noise:} s: $1 → $2 dB" || fail "$name: noise alone ${span#noise:} s not 10 dB quieter: $1 → $2 dB" ;;
      speech:*) set -- $(get "rms_${span#speech:}"); within "$1" "$2" 1.5 \
                 && pass "$name: speech ${span#speech:} s: $1 → $2 dB" || fail "$name: speech ${span#speech:} s changed level: $1 → $2 dB" ;;
    esac
  done
}

echo "== a.mp4: 60 s, H.264 1080p, stereo, filmed sideways, with a date and place"
JOB=$(uuidgen | tr "A-Z" "a-z"); STATE=$(clean a.mp4 mp4); echo "  $STATE"
case $STATE in *'"state":"done"'*) ;; *) fail "a.mp4 wasn't cleaned" ;; esac
FACTS=$(facts media/a.mp4 "work/$JOB/reduce-noise.video")
common_checks a.mp4 mp4 aac
within "$(get rotation | tr -d -)" 90 0.1 && pass "a.mp4: still turned 90°" || fail "a.mp4: rotation lost ($(get rotation))"
case "$(get place)|$(get date)" in
  "+15.4989+073.8278/|+15.4989+073.8278/|2026-10-20T08:30:00"*"|2026-10-20T08:30:00"*) pass "a.mp4: date and place kept ($(get date), $(get place))" ;;
  *) fail "a.mp4: date or place lost ($(get date), $(get place))" ;;
esac
noise_checks a.mp4 noise:1_9 noise:26_34 noise:51_59 speech:12_24 speech:37_49

for clip in "b.mov mov mp4 aac" "c.webm webm matroska opus" "d.mkv mkv matroska aac" "e.3gp 3gp mp4 aac"; do
  set -- $clip
  echo "== $1"
  JOB=$(uuidgen | tr "A-Z" "a-z"); STATE=$(clean "$1" "$2"); echo "  $STATE"
  case $STATE in *'"state":"done"'*) ;; *) fail "$1 wasn't cleaned" ;; esac
  FACTS=$(facts "media/$1" "work/$JOB/reduce-noise.video")
  common_checks "$1" "$3" "$4"
  [ "$1" = b.mov ] && noise_checks "$1" noise:1_9 || noise_checks "$1" noise:1_9 speech:12_24
done

echo "== f.mp4: no sound"
JOB=$(uuidgen | tr "A-Z" "a-z"); STATE=$(clean f.mp4 mp4); echo "  $STATE"
case $STATE in *'"state":"unsuitable"'*'no sound'*) pass "f.mp4: unsuitable, no sound" ;; *) fail "f.mp4: not refused as having no sound" ;; esac

echo "== g.mkv: a 2 s gap in the sound at 5 s"
JOB=$(uuidgen | tr "A-Z" "a-z"); STATE=$(clean g.mkv mkv); echo "  $STATE"
case $STATE in *'"state":"done"'*) ;; *) fail "g.mkv wasn't cleaned" ;; esac
FACTS=$(facts media/g.mkv "work/$JOB/reduce-noise.video")
common_checks g.mkv matroska aac

echo "== h.mkv: 30 minutes, its header saying 30 s"
JOB=$(uuidgen | tr "A-Z" "a-z"); STATE=$(clean h.mkv mkv); echo "  $STATE"
case $STATE in *'"state":"unsuitable"'*"too long"*) pass "h.mkv: unsuitable, too long (its sound counted, not its header)" ;; *) fail "h.mkv: not refused as too long" ;; esac
[ ! -e "$WORK/work/$JOB/reduce-noise.video" ] && pass "h.mkv: no copy made" || fail "h.mkv: a copy was made"

echo "== long.mp4: 10 minutes, stereo"
(while :; do docker stats --no-stream --format '{{.MemUsage}}' "$NAME" | cut -d/ -f1; sleep 0.5; done) >"$SAMPLES" 2>/dev/null &
STATS=$!
JOB=$(uuidgen | tr "A-Z" "a-z"); STATE=$(clean long.mp4 mp4); echo "  $STATE"
kill "$STATS" 2>/dev/null || true
STATS=""
case $STATE in *'"state":"done"'*) pass "long.mp4: cleaned" ;; *) fail "long.mp4 wasn't cleaned" ;; esac
FACTS=$(facts media/long.mp4 "work/$JOB/reduce-noise.video")
[ "$(get picture)" = same ] && pass "long.mp4: the picture's $(get packets) packets unchanged" || fail "long.mp4: the picture changed"
set -- $(get length); within "$1" "$2" 0.1 && pass "long.mp4: as long as the original ($1 s)" || fail "long.mp4: length changed ($1 → $2 s)"
awk '{ v = $1 + 0; if ($1 ~ /GiB/) v *= 1024; else if ($1 ~ /KiB/) v /= 1024; else if ($1 ~ /[0-9]B$/) v /= 1048576; if (v > max) max = v }
  END { printf "  the container'"'"'s memory peak while cleaning 10 minutes: %.0f MiB (its cap is 1 GiB)\n", max }' "$SAMPLES"
echo "  the container's own log (seconds, pieces, the model's time in ms):"
docker logs "$NAME" 2>&1 | grep '"kind":"reduce-noise"' | sed 's/^/    /'

if [ "$FAILED" -ne 0 ]; then echo "SOME CHECKS FAILED"; exit 1; fi
echo "all checks passed"
