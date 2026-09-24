#!/usr/bin/env bash
# Re-run the PoC on the Phase 2 samples and the Phase 2 follow-up samples, one at a time.
# Usage: regression.sh <output-dir> [ffmpeg-bin-dir]
#   ffmpeg-bin-dir: put this ffmpeg/ffprobe first on PATH (e.g. build/ffmpeg-lgpl/bin)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$1"; mkdir -p "$OUT"
[ -n "${2:-}" ] && export PATH="$2:$PATH"
echo "ffmpeg: $(command -v ffmpeg) — $(ffmpeg -hide_banner -L 2>/dev/null | sed -n 2p | sed 's/^ *//')"

run() { # sample [extra args...]
  local s="$1"; shift
  local name; name="$(basename "$s" .mp4)"
  rm -rf "${OUT:?}/$name"
  local t0; t0=$(date +%s)
  node "$ROOT/scripts/poc-convert.mjs" "$ROOT/samples/$s" --output "$OUT" "$@" > "$OUT/$name.log" 2>&1
  local rc=$?
  printf "%-28s rc=%s ok=%s fail=%s sec=%s %s\n" "$name" "$rc" "$(grep -c '^  ok' "$OUT/$name.log")" \
    "$(grep -c 'FAIL' "$OUT/$name.log")" "$(( $(date +%s) - t0 ))" "$(grep durations "$OUT/$name.log" | sed 's/  durations   //')"
}

for s in standard-16x9 aspect-4x3 vertical-1080x1920 rotated-90 fps-30 fps-59.94 fps-23.976 audio-5.1 no-audio \
         audio-5.1-loud audio-mono motion/m-50 motion/m-25 motion/m-vfr; do
  run "$s.mp4"
done
run long-20min-noise.mp4
