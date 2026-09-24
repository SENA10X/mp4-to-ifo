#!/usr/bin/env bash
# Compare stereo AC-3 bitrates on a dense synthetic signal (pink noise + sweeps + HF tones + bursts).
# Reports size, signal-to-distortion ratio (asdr), and residual high-frequency energy (bandwidth).
# Also checks mono -> stereo level with -ac 2.
# The AC-3 decode is 256 samples late (encoder delay, measured by cross-correlation) and is trimmed before asdr.
# Usage: ac3-bitrate.sh <work-dir>
set -euo pipefail
W="$1"; mkdir -p "$W"; cd "$W"
FF=(ffmpeg -hide_banner -nostdin -loglevel error -y)

"${FF[@]}" -f lavfi -i "sine=440:sample_rate=48000:d=5" -af volume=-6dB mono.wav
"${FF[@]}" -i mono.wav -ac 2 -c:a ac3 -b:a 256k mono.ac3
echo "mono -6 dBFS -> -ac 2 -> AC-3, per-channel peak:"
ffmpeg -hide_banner -i mono.ac3 -af astats=measure_perchannel=Peak_level:measure_overall=none -f null - 2>&1 | grep "Peak level" | head -2

"${FF[@]}" -f lavfi -i "anoisesrc=c=pink:a=0.15:r=48000:d=30" \
  -f lavfi -i "aevalsrc='0.2*sin(2*PI*(200+3000*t/30)*t)+0.1*sin(2*PI*6000*t)*lt(mod(t,0.5),0.05)+0.08*sin(2*PI*12000*t)+0.05*sin(2*PI*16500*t)|0.2*sin(2*PI*(250+2800*t/30)*t)+0.1*sin(2*PI*9000*t)*lt(mod(t,0.37),0.03)+0.05*sin(2*PI*17500*t)':s=48000:d=30" \
  -filter_complex "[0][1]amerge=inputs=2,pan=stereo|c0=c0+c1|c1=c0+c2" -c:a pcm_f32le dense.wav

bands() {
  for hz in 14000 16000 18000; do
    printf ">%dk %s dB  " $((hz / 1000)) "$(ffmpeg -hide_banner -i "$1" -af "highpass=f=$hz,highpass=f=$hz,highpass=f=$hz,astats=measure_perchannel=none:measure_overall=RMS_level" -f null - 2>&1 | awk '/RMS level dB/{print $NF}')"
  done
}
echo "source          $(bands dense.wav)"
for br in 192 224 256 448; do
  "${FF[@]}" -i dense.wav -c:a ac3 -b:a ${br}k -ar 48000 "d$br.mka"
  sdr=$(ffmpeg -hide_banner -i dense.wav -i "d$br.mka" -filter_complex "[1]atrim=start_sample=256,asetpts=PTS-STARTPTS[d];[0][d]asdr" -f null - 2>&1 | grep -oE "SDR ch[0-9]+: [-0-9.]+ dB" | tr '\n' ' ')
  printf "%sk  %8s B  %s| %s\n" "$br" "$(stat -f %z "d$br.mka")" "$sdr" "$(bands "d$br.mka")"
done
