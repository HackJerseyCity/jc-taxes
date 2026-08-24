#!/usr/bin/env bash
# Build + run the puppeteer-capture Docker container (Linux-only beginFrame
# capture) and produce a video of the JC tax animation. Bundles previously
# separate build / run / kill / frame-extract steps into one idempotent CLI.
#
# Usage:
#   capture-docker.sh                       # build + record (defaults below)
#   capture-docker.sh -s 4 -f 15            # 4 seconds at 15fps
#   capture-docker.sh -t 60                 # auto-kill container after 60s
#   capture-docker.sh -F                    # also extract a verification PNG frame
#   capture-docker.sh --rebuild             # force `docker build` (no cache)
#   capture-docker.sh --clean               # stop+remove prior container, then exit
#
# Env (all optional, override CLI defaults):
#   PLATFORM, JCT_URL, JCT_OUT, JCT_SECS, JCT_FPS, JCT_TIMEOUT
#
# Requires: macOS or Linux + Docker. The base puppeteer image is amd64-only,
# so on arm64 hosts it runs under emulation.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
TMP="$ROOT/tmp"
mkdir -p "$TMP"

NAME="jct-capture-run"
SECS="${JCT_SECS:-9}"
FPS="${JCT_FPS:-30}"
TIMEOUT="${JCT_TIMEOUT:-120}"
URL="${JCT_URL:-http://host.docker.internal:3201/?agg=lot&3d=1&y=2018&animYr=2018-2025:1&v=40.7197-74.0506+12.0+45+0}"
OUT_BASENAME="jc-anim.mp4"
EXTRACT_FRAME=0
REBUILD=0
CLEAN_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -s|--secs)     SECS="$2"; shift 2 ;;
    -f|--fps)      FPS="$2"; shift 2 ;;
    -t|--timeout)  TIMEOUT="$2"; shift 2 ;;
    -u|--url)      URL="$2"; shift 2 ;;
    -o|--out)      OUT_BASENAME="$(basename "$2")"; shift 2 ;;
    -F|--frame)    EXTRACT_FRAME=1; shift ;;
    --rebuild)     REBUILD=1; shift ;;
    --clean)       CLEAN_ONLY=1; shift ;;
    -h|--help)     sed -n '2,/^set -e/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

OUT="/out/$OUT_BASENAME"
HOST_OUT="$TMP/$OUT_BASENAME"

cleanup_prior() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "[capture] removing prior container $NAME"
    docker rm -f "$NAME" >/dev/null
  fi
}

cleanup_prior

if [ "$CLEAN_ONLY" = 1 ]; then
  exit 0
fi

PLATFORM_FLAG=""
TAG_SUFFIX=""
if [ -n "${PLATFORM:-}" ]; then
  PLATFORM_FLAG="--platform=$PLATFORM"
  TAG_SUFFIX="-$(echo "$PLATFORM" | tr '/' '-')"
fi
TAG="jct-capture${TAG_SUFFIX}:latest"

BUILD_ARGS=()
[ "$REBUILD" = 1 ] && BUILD_ARGS+=(--no-cache)
echo "[capture] building $TAG ${PLATFORM_FLAG:-}"
( cd "$DIR" && docker build "${BUILD_ARGS[@]}" $PLATFORM_FLAG -t "$TAG" -f docker/Dockerfile.capture . )

echo "[capture] running $NAME (timeout=${TIMEOUT}s)"
echo "  URL  = $URL"
echo "  OUT  = $OUT (host: $HOST_OUT)"
echo "  SECS = $SECS  FPS = $FPS"

# Run detached so we can attach logs + enforce a watchdog timeout, instead of
# leaving an orphan container if the host script is interrupted.
docker run -d --name "$NAME" $PLATFORM_FLAG \
  --add-host=host.docker.internal:host-gateway \
  -v "$DIR/scripts":/app/scripts:ro \
  -v "$TMP":/out \
  -e JCT_URL="$URL" \
  -e JCT_OUT="$OUT" \
  -e JCT_SECS="$SECS" \
  -e JCT_FPS="$FPS" \
  -e JCT_MODE="${JCT_MODE:-capture}" \
  "$TAG" >/dev/null

start_ts=$(date +%s)
docker logs -f "$NAME" &
LOGS_PID=$!

# Watchdog: poll container state and elapsed wall time. Kill on timeout.
exit_code=""
while :; do
  if ! docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true; then
    exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME" 2>/dev/null || echo unknown)"
    break
  fi
  now=$(date +%s)
  if [ "$((now - start_ts))" -ge "$TIMEOUT" ]; then
    echo "[capture] TIMEOUT after ${TIMEOUT}s, killing container"
    docker kill "$NAME" >/dev/null 2>&1 || true
    exit_code="timeout"
    break
  fi
  sleep 2
done

# Stop the log-tail (it will exit on its own once the container is gone, but
# kill defensively so we don't leak a stray process).
kill "$LOGS_PID" 2>/dev/null || true
wait "$LOGS_PID" 2>/dev/null || true

echo "[capture] container exit: $exit_code"

if [ "$exit_code" != "0" ]; then
  echo "[capture] FAILED — container did not finish cleanly" >&2
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit 1
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true

if [ ! -s "$HOST_OUT" ]; then
  echo "[capture] no output written to $HOST_OUT" >&2
  exit 1
fi

ls -lh "$HOST_OUT"
ffprobe -v error -show_entries stream=width,height,nb_frames,r_frame_rate,duration -of default=noprint_wrappers=1 "$HOST_OUT" 2>/dev/null || true

if [ "$EXTRACT_FRAME" = 1 ]; then
  FRAME="${HOST_OUT%.mp4}-frame.png"
  mid=$(awk "BEGIN{printf \"%.2f\", $SECS/2}")
  ffmpeg -y -loglevel error -i "$HOST_OUT" -ss "$mid" -frames:v 1 -update 1 "$FRAME"
  echo "[capture] sample frame: $FRAME"
fi
