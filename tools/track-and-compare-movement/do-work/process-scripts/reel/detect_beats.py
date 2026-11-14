#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/detect_beats.py
#
# PURPOSE: perception stage `audio.beat.track`. Emits `beat_track.v1` {tempo, beats:[t...]} from
# an audio/video file via librosa beat tracking. This is the DATA that drives media-composition's
# beat-synced cuts (author one timeline split per beat so clip boundaries land on the music).
# Detection lives HERE (perception owner); the compositor only consumes the beat-time list, so the
# two couple ONLY through the emitted DATA (Envelope), never a code import.
#
# MODEL/PARAMS ARE DATA: --units (time|frames), --start-bpm hint, --tightness are pass-through knobs.
# FAIL-SOFT: a silent or beatless clip yields an empty beat list with tempo 0, never a crash and
# never a fabricated grid.
#
# USAGE: detect_beats.py --clip CLIP.(mp4|wav|mp3) --out BEATS.json [--start-bpm 120] [--tightness 100]
from __future__ import annotations
import argparse, json, sys
from pathlib import Path


def log(m): print(f"[audio.beat.track] {m}", file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="perception audio.beat.track: tempo + beat times.")
    ap.add_argument("--clip", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--start-bpm", type=float, default=120.0)
    ap.add_argument("--tightness", type=float, default=100.0)
    a = ap.parse_args()
    if not Path(a.clip).exists():
        log(f"REFUSED: clip missing: {a.clip}")
        return 2
    try:
        import librosa
        import numpy as np
    except Exception as e:
        log(f"REFUSED: librosa/numpy unavailable: {e}")
        return 3
    try:
        y, sr = librosa.load(a.clip, sr=None, mono=True)
    except Exception as e:
        log(f"REFUSED: cannot decode audio: {e}")
        return 1
    if y is None or len(y) == 0 or float(np.max(np.abs(y))) < 1e-4:
        out = {"kind": "beat_track.v1", "tempo": 0.0, "beats": [],
               "provenance": {"stage": "audio.beat.track", "reason": "silent-or-empty"}}
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        json.dump(out, open(a.out, "w"))
        log("silent or empty -> 0 beats")
        return 0
    tempo, beat_frames = librosa.beat.beat_track(
        y=y, sr=sr, start_bpm=a.start_bpm, tightness=a.tightness, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    beats = [round(float(t), 3) for t in beat_times]
    tempo_val = float(np.atleast_1d(tempo)[0])
    out = {"kind": "beat_track.v1", "tempo": round(tempo_val, 2), "beats": beats,
           "provenance": {"stage": "audio.beat.track", "sr": int(sr), "confidence": 1.0}}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(a.out, "w"))
    log(f"tempo={tempo_val:.1f} bpm, {len(beats)} beats -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
