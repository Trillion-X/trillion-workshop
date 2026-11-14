#!/usr/bin/env bash
# whip-pan.sh A B OUT DUR W H FPS
# A "whip pan" transition: clip A slides off-frame to the left while clip B slides in from the right,
# BOTH under a heavy horizontal motion blur (avgblur sizeX). It composites two moving, blurred layers
# via time-driven overlay-x, which ffmpeg xfade (a single pairwise per-pixel blend with no sliding
# composite and no directional blur) structurally cannot do. So this `process` renderer PROVES the
# transition primitive is clay: a Kolder-grade transition the built-in renderers cannot make, added as
# ONE DATA row, zero engine change. Swap this binary for a gl-transitions GLSL runner or an AI morph
# (RIFE/FILM) and it plugs in identically.
set -euo pipefail
A="$1"; B="$2"; OUT="$3"; DUR="${4:-0.5}"; W="${5:-1920}"; H="${6:-1080}"; FPS="${7:-30}"
ffmpeg -y -hide_banner -loglevel error -i "$A" -i "$B" -filter_complex "\
[0:v]scale=${W}:${H},setsar=1,fps=${FPS},avgblur=sizeX=28:sizeY=1,setpts=PTS-STARTPTS[a];\
[1:v]scale=${W}:${H},setsar=1,fps=${FPS},avgblur=sizeX=28:sizeY=1,setpts=PTS-STARTPTS[b];\
color=c=black:s=${W}x${H}:r=${FPS}:d=${DUR}[bg];\
[bg][a]overlay=x='-${W}*(t/${DUR})':y=0:shortest=1[o1];\
[o1][b]overlay=x='${W}-${W}*(t/${DUR})':y=0:shortest=1,format=yuv420p[v];\
anullsrc=r=48000:cl=stereo[s]" \
  -map "[v]" -map "[s]" -t "${DUR}" -c:v libx264 -crf 20 -preset veryfast -c:a aac -ar 48000 -ac 2 -b:a 256k "$OUT"
