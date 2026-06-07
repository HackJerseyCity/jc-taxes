#!/usr/bin/env bash
# Regenerate the year-cycling animation video via `scrns` (puppeteer headful,
# real GPU, frame-by-frame). Each invocation writes a fresh basename so
# QuickTime opens a new review window instead of reusing a stale one.
#
# Usage: regen-anim.sh [NAME]
#   NAME defaults to `anim-frac-vN` from scrns.config.ts; pass an explicit
#   override (e.g. `anim-frac-v6-debug`) to test alternatives.
#
# Requires: dev server at :3201 (vite), `node_modules/.bin/scrns`,
# puppeteer's Chrome installed at ~/.cache/puppeteer/chrome/...

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # www/
ROOT="$(cd "$DIR/.." && pwd)"                            # repo root
TMP="$ROOT/tmp"
mkdir -p "$TMP"

# Pick name: explicit CLI arg, or pull all `anim-frac-…` keys from the config.
# With no arg, runs each `anim-frac-*` entry sequentially.
if [ $# -gt 0 ]; then
  NAMES=("$@")
else
  mapfile -t NAMES < <(grep -oE "'anim-frac-[A-Za-z0-9-]+'" "$DIR/scrns.config.ts" | tr -d "'")
fi
if [ ${#NAMES[@]} -eq 0 ]; then
  echo "[regen-anim] could not infer name; pass one as the first arg" >&2
  exit 1
fi

# Ensure dev server is up before scrns tries to load the URL.
if ! curl -sf -o /dev/null "http://localhost:3201/"; then
  echo "[regen-anim] dev server not responding at :3201; run \`pnpm dev\` first" >&2
  exit 1
fi

for NAME in "${NAMES[@]}"; do
  OUT="$TMP/$NAME.mp4"
  echo "[regen-anim] target: $OUT"
  rm -f "$OUT"
  "$DIR/node_modules/.bin/scrns" \
    -c "$DIR/scrns.config.ts" \
    -i "$NAME" \
    -o "$TMP" 2>&1 | tee "$TMP/$NAME.log" | tail -10
  if [ ! -s "$OUT" ]; then
    echo "[regen-anim] no output written for $NAME; see $TMP/$NAME.log" >&2
    exit 1
  fi
  echo "[regen-anim] OK: $(ls -lh "$OUT" | awk '{print $5}'), opening in QuickTime"
  open "$OUT"
done
