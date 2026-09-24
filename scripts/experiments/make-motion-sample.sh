#!/usr/bin/env bash
# Generate a test MP4 whose frames carry their own index as a 12-bit black/white code,
# with a 20 ms 1 kHz click at every whole second. Used with motion-probe.mjs.
#
# Usage: make-motion-sample.sh <rate> <seconds> <out.mp4> [vfr]
#   rate: frame rate of the coded frames (e.g. 60000/1001, 25, 24000/1001)
#   vfr:  drop frames in an irregular pattern and keep original timestamps (VFR MP4)
# Source time of a frame is always <code> / <rate>.
set -euo pipefail

RATE="$1"; DUR="$2"; OUT="$3"; MODE="${4:-cfr}"

BOXES=""
for i in $(seq 0 11); do
  BOXES+=",drawbox=x=$((i * 100 + 40)):y=0:w=100:h=720:color=white:t=fill:enable='eq(mod(floor(n/$((1 << i))),2),1)'"
done

SELECT=""
FPSMODE=()
if [ "$MODE" = vfr ]; then
  # Alternate 1 s full rate / 2 s half rate, plus irregular single drops.
  SELECT=",select='not(gte(mod(t,3),1)*mod(n,2))*not(eq(mod(n*7,23),0))'"
  FPSMODE=(-fps_mode vfr)
fi

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=black:s=1280x720:r=$RATE:d=$DUR" \
  -f lavfi -i "aevalsrc='if(lt(mod(t,1),0.02),0.5*sin(2*PI*1000*t),0)':s=48000:d=$DUR" \
  -filter_complex "[0:v]format=yuv420p${BOXES}${SELECT}[v];[1:a]pan=stereo|c0=c0|c1=c0[a]" \
  -map "[v]" -map "[a]" ${FPSMODE[@]+"${FPSMODE[@]}"} \
  -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "$OUT"
