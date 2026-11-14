#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/render_vertical_crop.py
#
# PURPOSE: Reel-factory stage [9] `render.vertical_crop_publish` — produce the final 9:16 vertical
# reel (1080x1920) ready for Blotato/content-distribution, optionally burning the word-timed captions
# (from stage [6]'s .srt rendering) and mixing in the voiceover (from stage [8]). Deterministic
# ffmpeg compositing — not a learned model.
#
# GENERIC: pads/scales any input to 9:16 and burns any subtitle file; zero domain knowledge.
#
# FAIL-CLOSED: unreadable input or ffmpeg failure -> non-zero exit + reason.
#
# USAGE: render_vertical_crop.py --in SXS.mp4 --out REEL.mp4 [--srt CAP.srt] [--voiceover VO.wav]
from __future__ import annotations
import argparse, subprocess, sys
from pathlib import Path


def log(m): print(f"[render.crop] {m}", file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Reel stage render.vertical_crop_publish: 1080x1920 + captions + VO.")
    ap.add_argument("--in", dest="inp", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--srt", default=None); ap.add_argument("--voiceover", default=None)
    a = ap.parse_args()
    if not Path(a.inp).exists():
        log(f"REFUSED: input missing: {a.inp}"); return 2
    # scale to fit 1080 wide, pad to 1920 tall, center — the universal 9:16 reframe.
    vf = "scale=1080:-2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"
    if a.srt and Path(a.srt).exists():
        esc = a.srt.replace(":", "\\:").replace(",", "\\,")
        vf += f",subtitles='{esc}':force_style='Alignment=2,FontSize=22,PrimaryColour=&H00FFFFFF,BorderStyle=3,BackColour=&H80000000'"
    cmd = ["ffmpeg", "-y", "-i", a.inp]
    if a.voiceover and Path(a.voiceover).exists():
        cmd += ["-i", a.voiceover]
    cmd += ["-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p"]
    if a.voiceover and Path(a.voiceover).exists():
        cmd += ["-map", "0:v:0", "-map", "1:a:0", "-shortest", "-c:a", "aac"]
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    cmd += [a.out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not Path(a.out).exists():
        log(f"REFUSED: ffmpeg failed: {r.stderr[-240:]}"); return 1
    log(f"final 9:16 reel -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
