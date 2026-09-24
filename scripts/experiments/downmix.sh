#!/usr/bin/env bash
# Compare 5.1 -> stereo downmix matrices on synthetic 5.1 signals.
# Reports sample peak / RMS / clipped samples of the float downmix, and peak after AC-3 256k round trip.
# Usage: downmix.sh <work-dir>
set -euo pipefail
W="$1"; mkdir -p "$W"
FF=(ffmpeg -hide_banner -nostdin -loglevel error -y)

# Channel order of the "5.1" layout: FL FR FC LFE BL BR
tone() { echo "$2*sin(2*PI*$1*t)"; }
mk() { # name, 6 channel expressions
  "${FF[@]}" -f lavfi -i "aevalsrc='$2|$3|$4|$5|$6|$7':s=48000:d=10:c=5.1" -c:a pcm_f32le "$W/$1.wav"
}
# T1 all channels the same tone at -6 dBFS (worst case, fully coherent)
mk coherent "$(tone 1000 0.5)" "$(tone 1000 0.5)" "$(tone 1000 0.5)" "$(tone 1000 0.5)" "$(tone 1000 0.5)" "$(tone 1000 0.5)"
# T2 typical: music L/R -10 dBFS, dialog-like C -12 dBFS, ambience surrounds -20 dBFS, LFE -10 dBFS
mk typical "$(tone 440 0.316)" "$(tone 554 0.316)" "0.25*sin(2*PI*300*t)*(0.6+0.4*sin(2*PI*3*t))" "$(tone 50 0.316)" "0.1*(random(0)-0.5)*2" "0.1*(random(1)-0.5)*2"
# T3 stereo content delivered as 5.1: only FL/FR at -3 dBFS
mk frontonly "$(tone 440 0.708)" "$(tone 554 0.708)" 0 0 0 0
# T4 loud master: FL/FR/C near -3 dBFS, surrounds -6 dBFS, partially correlated
mk loud "$(tone 220 0.708)" "$(tone 330 0.708)" "$(tone 220 0.708)" "$(tone 40 0.708)" "$(tone 220 0.5)" "$(tone 330 0.5)"

declare -a NAMES FILTERS
NAMES+=("M0 ffmpeg -ac 2 default");        FILTERS+=("aresample=ochl=stereo")
NAMES+=("M1 ITU Lo/Ro, no norm");          FILTERS+=("pan=stereo|FL=FL+0.7071*FC+0.7071*BL|FR=FR+0.7071*FC+0.7071*BR")
NAMES+=("M2 ITU Lo/Ro, normalized (/2.414)"); FILTERS+=("pan=stereo|FL<FL+0.7071*FC+0.7071*BL|FR<FR+0.7071*FC+0.7071*BR")
NAMES+=("M3 ITU Lo/Ro + clip guard");      FILTERS+=("GUARD")

stats() { # file filter -> "peak_dB rms_dB clipped"
  "${FF[@]}" -loglevel info -i "$1" -af "$2,astats=measure_perchannel=none:measure_overall=Peak_level+RMS_level" -f null - 2>&1 |
    awk '/Peak level dB/{p=$NF} /RMS level dB/{r=$NF} END{printf "%s %s", p, r}'
}
clipped() { # count |x| >= 1.0 in float output
  "${FF[@]}" -i "$1" -af "$2" -f f32le -ac 2 - | node -e 'const b=require("fs").readFileSync(0);let c=0;for(let i=0;i<b.length;i+=4)if(Math.abs(b.readFloatLE(i))>=1)c++;console.log(c)'
}

printf "%-10s %-34s %9s %9s %8s %11s\n" signal matrix peak_dB rms_dB clipped ac3_peak_dB
for sig in coherent typical frontonly loud; do
  for i in "${!NAMES[@]}"; do
    f="${FILTERS[$i]}"
    if [ "$f" = GUARD ]; then
      # Static gain so the M1 downmix peaks at -1 dBFS; never boost.
      base="${FILTERS[1]}"
      peak=$(stats "$W/$sig.wav" "$base" | cut -d' ' -f1)
      gain=$(node -e "console.log(Math.min(0, -1 - Number('$peak')).toFixed(2))")
      f="$base,volume=${gain}dB"
    fi
    read -r pk rms <<<"$(stats "$W/$sig.wav" "$f")"
    cl=$(clipped "$W/$sig.wav" "$f")
    "${FF[@]}" -i "$W/$sig.wav" -af "$f" -c:a ac3 -b:a 256k -ar 48000 "$W/out.ac3"
    ac3pk=$(stats "$W/out.ac3" "anull" | cut -d' ' -f1)
    printf "%-10s %-34s %9s %9s %8s %11s\n" "$sig" "${NAMES[$i]}" "$pk" "$rms" "$cl" "$ac3pk"
  done
done
# Reference: source per-channel levels
for sig in coherent typical frontonly loud; do
  printf "source %-10s FL peak %s\n" "$sig" "$(stats "$W/$sig.wav" "pan=mono|c0=FL" | cut -d' ' -f1)"
done
