#!/usr/bin/env bash
# Scan a video for visual jumps between consecutive frames by computing the
# mean per-pixel diff. Emits frames where the diff exceeds a threshold so we
# can eyeball boundary artifacts (year transitions, layer re-inits, etc).
#
# Usage: scan-jumps.sh <mp4> [threshold]
#   threshold: mean per-pixel RMSE (0-255 scale). Default 3.0 — flags only
#   obviously discontinuous frame pairs; raise for noisier inspection.
#
# Output: prints one line per flagged transition + writes side-by-side
# composite PNGs under tmp/jumps/<basename>/.

set -euo pipefail

MP4="${1:?usage: scan-jumps.sh <mp4> [threshold]}"
THRESH="${2:-3.0}"

if [ ! -f "$MP4" ]; then
  echo "[scan-jumps] not found: $MP4" >&2; exit 1
fi

BASE="$(basename "${MP4%.*}")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$ROOT/tmp/jumps/$BASE"
mkdir -p "$WORK"
rm -f "$WORK"/*.png

echo "[scan-jumps] extracting frames → $WORK"
# Encode frames at ~original fps so consecutive-frame diffs reflect actual playback.
ffmpeg -y -loglevel error -i "$MP4" -vf "scale=400:-1" "$WORK/f-%04d.png"

cd "$WORK"
frames=(f-*.png)
total=${#frames[@]}
echo "[scan-jumps] $total frames, threshold=$THRESH"

flagged=0
prev=""
for f in "${frames[@]}"; do
  if [ -n "$prev" ]; then
    # Use IM's mean per-pixel RGB diff (0-255 scale via -metric RMSE).
    rmse=$(magick compare -metric RMSE "$prev" "$f" null: 2>&1 | awk '{print $1}')
    big=$(awk -v r="$rmse" -v t="$THRESH" 'BEGIN{print (r>t)?1:0}')
    if [ "$big" = 1 ]; then
      idx_prev=$(echo "$prev" | grep -oE '[0-9]+')
      idx_cur=$(echo "$f" | grep -oE '[0-9]+')
      out="diff-${idx_prev}-${idx_cur}-rmse${rmse}.png"
      magick "$prev" "$f" +append "$out"
      printf "  frame %s → %s : RMSE=%s\n" "$idx_prev" "$idx_cur" "$rmse"
      flagged=$((flagged+1))
    fi
  fi
  prev="$f"
done

echo "[scan-jumps] flagged $flagged transitions; composites in $WORK"
