#!/usr/bin/env bash
# Measure 2-pass MPEG-2 rate-control accuracy, PS mux overhead and SSIM at several target bitrates,
# using the PoC encoder settings. Content: heavy noise (worst case) and testsrc2 + light noise.
# Usage: rate-control.sh <work-dir> [ffmpeg-bin-dir]
set -euo pipefail
W="$1"; mkdir -p "$W"; cd "$W"
BIN="${2:-}"; FFMPEG="${BIN:+$BIN/}ffmpeg"
DUR=180

gen() { # name, lavfi video
  [ -f "$1.mkv" ] || ffmpeg -hide_banner -nostdin -loglevel error -y -f lavfi -i "$2" \
    -f lavfi -i "sine=440:sample_rate=48000:d=$DUR" -t $DUR -c:v ffv1 -c:a flac "$1.mkv"
}
gen noise "testsrc2=s=720x480:r=30000/1001,noise=alls=40:allf=t+u,setsar=32/27"
gen easy "testsrc2=s=720x480:r=30000/1001,noise=alls=6:allf=t,setsar=32/27"

V=(-c:v mpeg2video -maxrate 9000k -minrate 0 -bufsize 1835008 -g 18 -bf 2 -flags +ildct+ilme -top 1 -aspect 16:9)
printf "%-6s %7s %8s %8s %7s %7s %6s\n" content target actual error% muxOH% ssim sec
for c in noise easy; do
  for kbps in 2000 3000 4000 5000 8000; do
    t0=$(date +%s)
    "$FFMPEG" -hide_banner -nostdin -loglevel error -y -i $c.mkv "${V[@]}" -b:v ${kbps}k -passlogfile p -pass 1 -an -f null -
    "$FFMPEG" -hide_banner -nostdin -loglevel error -y -i $c.mkv "${V[@]}" -b:v ${kbps}k -passlogfile p -pass 2 \
      -c:a ac3 -b:a 256k -ar 48000 -ac 2 -f dvd -muxrate 10080000 -packetsize 2048 out.mpg
    sec=$(( $(date +%s) - t0 ))
    "$FFMPEG" -hide_banner -nostdin -loglevel error -y -i out.mpg -map 0:v -c copy -f mpeg2video out.m2v
    "$FFMPEG" -hide_banner -nostdin -loglevel error -y -i out.mpg -map 0:a -c copy -f ac3 out.ac3
    ssim=$("$FFMPEG" -hide_banner -nostdin -i out.mpg -i $c.mkv -lavfi "[0:v][1:v]ssim" -f null - 2>&1 | grep -oE "All:[0-9.]+" | cut -d: -f2)
    node -e '
      const s=(f)=>require("fs").statSync(f).size;const [t,c,ssim,sec,d]=process.argv.slice(1);
      const v=s("out.m2v"),a=s("out.ac3"),m=s("out.mpg");const act=v*8/d/1000;
      console.log(`${c.padEnd(6)} ${t.padStart(7)} ${act.toFixed(0).padStart(8)} ${((act/t-1)*100).toFixed(2).padStart(8)} ${((m/(v+a)-1)*100).toFixed(2).padStart(7)} ${ssim.padStart(7)} ${sec.padStart(6)}`)' \
      $kbps $c "$ssim" $sec $DUR
  done
done
