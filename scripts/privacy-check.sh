#!/usr/bin/env bash
# Run before pushing: fails if a file that would be committed (tracked, or untracked and not
# ignored) holds one of your private strings or a value from .env, in its text or its name.
#
#   scripts/privacy-check.sh
#   PRIVACY_PATTERNS=/path/to/patterns.txt scripts/privacy-check.sh
#
# Patterns file (default private/privacy-patterns.txt, never committed): one string per line,
# matched anywhere, ignoring case. Blank lines and lines starting with # are skipped.
# .env values of 8 characters or more are matched as they are; only file:line and the name
# of the setting are shown, never the value.
# Not checked: TZ, DEV_TZ, AWS_REGION, ANDROID_KEYSTORE_PATH and ANDROID_KEYSTORE_ALIAS.
# Exit: 0 nothing found, 1 something found, 2 the check couldn't run.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
patterns="${PRIVACY_PATTERNS:-$root/private/privacy-patterns.txt}"

cant_run() {
  echo "$*" >&2
  exit 2
}

if [ ! -f "$patterns" ]; then
  cant_run "No patterns file at $patterns.
Write one (one private string per line: your name, domain, email, account ids...) or set PRIVACY_PATTERNS."
fi

work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
tr -d '\r' < "$patterns" | grep -v -e '^[[:space:]]*$' -e '^#' > "$work/patterns" || true
[ -s "$work/patterns" ] || cant_run "$patterns has no patterns in it."

cd "$root"
git -c core.quotePath=false ls-files -z --cached --others --exclude-standard > "$work/files.z"
tr '\0' '\n' < "$work/files.z" > "$work/files"
count=$(tr -cd '\0' < "$work/files.z" | wc -c | tr -d ' ')
[ "$(wc -l < "$work/files" | tr -d ' ')" = "$count" ] || cant_run "A file name has a line break in it: rename it first."

# scan LIST [-i]: the files whose name or text matches a string in LIST, into $work/hits
# (one "name: <path>", "<path>:<line>" or "<path> (binary)" per line).
scan() {
  local list=$1 status path line
  shift
  : > "$work/hits"
  : > "$work/hit-paths"
  status=0
  grep "$@" -F -f "$list" "$work/files" > "$work/names" || status=$?
  [ "$status" -le 1 ] || cant_run "The file name check failed."
  sed 's/^/name: /' "$work/names" >> "$work/hits"
  status=0
  git -c core.quotePath=false grep --untracked -I --null -n "$@" -F -f "$list" > "$work/lines" || status=$?
  [ "$status" -le 1 ] || cant_run "The file text check failed (git grep exit $status)."
  while IFS= read -r -d '' path && IFS= read -r -d '' line && IFS= read -r _; do
    printf '%s:%s\n' "$path" "$line" >> "$work/hits"
    printf '%s\n' "$path" >> "$work/hit-paths"
  done < "$work/lines"
  status=0
  git -c core.quotePath=false grep --untracked --null -l "$@" -F -f "$list" > "$work/all" || status=$?
  [ "$status" -le 1 ] || cant_run "The binary file check failed (git grep exit $status)."
  while IFS= read -r -d '' path; do
    grep -q -F -x -e "$path" "$work/hit-paths" || printf '%s (binary)\n' "$path" >> "$work/hits"
  done < "$work/all"
}

: > "$work/report"
scan "$work/patterns" -i
sed 's/^/  /' "$work/hits" >> "$work/report"

if [ -f "$root/.env" ]; then
  (umask 077 && tr -d '\r' < "$root/.env" | sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)=\(.*\)$/\1=\2/p' > "$work/env")
  while IFS= read -r entry; do
    key=${entry%%=*}
    case "$key" in TZ | DEV_TZ | AWS_REGION | ANDROID_KEYSTORE_PATH | ANDROID_KEYSTORE_ALIAS) continue ;; esac
    value=$(printf '%s' "${entry#*=}" |
      sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
    [ "${#value}" -ge 8 ] || continue
    (umask 077 && printf '%s\n' "$value" > "$work/value")
    scan "$work/value"
    while IFS= read -r hit; do
      printf '  %s (the value of %s in .env)\n' "${hit//"$value"/<$key>}" "$key" >> "$work/report"
    done < "$work/hits"
  done < "$work/env"
  value=""
  rm -f "$work/env" "$work/value"
else
  echo "No .env at the top of the repo: its values aren't checked."
fi

if [ ! -s "$work/report" ]; then
  echo "Privacy check passed: $count files, $(wc -l < "$work/patterns" | tr -d ' ') patterns, nothing found."
  exit 0
fi
echo "Privacy check FAILED. Private strings found in:" >&2
cat "$work/report" >&2
exit 1
