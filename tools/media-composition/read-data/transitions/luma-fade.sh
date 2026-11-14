#!/usr/bin/env bash
# luma-fade.sh A B OUT DUR W H FPS
# Sam Kolder's signature LUMA FADE (a luminance MATTE transition, not a blend): clip B is revealed
# THROUGH the brightest areas of clip A first, the reveal threshold sweeping over the duration, with a
# feathered (blurred) matte edge. This is a track-matte / "Composite Using: Matte Luma" in Premiere,
# built here as a real per-pixel luma matte via geq (time-driven threshold) + maskedmerge. It is a
# MASKING transition, structurally different from xfade's pairwise blend, and it runs as ONE `process`
# DATA row (zero engine change). The same slot hosts AI masking (Robust Video Matting / SAM2 roto) by
# swapping this binary for a matting model, which is how the fly-through / object-reveal masks get
# automated now that AI does the roto.
set -euo pipefail
A="$1"; B="$2"; OUT="$3"; DUR="${4:-0.6}"; W="${5:-1920}"; H="${6:-1080}"; FPS="${7:-30}"
ffmpeg -y -hide_banner -loglevel error -i "$A" -i "$B" -filter_complex "\
[0:v]scale=${W}:${H},setsar=1,fps=${FPS},setpts=PTS-STARTPTS,split=2[a1][a2];\
[1:v]scale=${W}:${H},setsar=1,fps=${FPS},setpts=PTS-STARTPTS[b];\
[a2]format=gray,geq=lum='255*gt(lum(X,Y),255*(1-clip(T/${DUR},0,1)))',boxblur=6:1[m];\
[b][m]alphamerge[ba];\
[a1][ba]overlay=format=auto,format=yuv420p[v];\
anullsrc=r=48000:cl=stereo[s]" \
  -map "[v]" -map "[s]" -t "${DUR}" -c:v libx264 -crf 20 -preset veryfast -c:a aac -ar 48000 -ac 2 -b:a 256k "$OUT"
