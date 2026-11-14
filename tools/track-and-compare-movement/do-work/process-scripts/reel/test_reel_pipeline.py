#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/test_reel_pipeline.py
#
# Regression tests for the reel-factory stage scripts. Pure-logic + fail-closed contracts, no video
# I/O (render/asr stages proven live in the T3 proof artifacts). Run: python3 -m pytest test_reel_pipeline.py -q
from __future__ import annotations
import json, subprocess, sys, math
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _synthetic_track(n_frames: int, phase_shift: float = 0.0, speed: float = 1.0) -> dict:
    """A moving COCO-17 skeleton: wrists swing on a sine so two tracks differ in phase/speed."""
    frames = []
    for i in range(n_frames):
        t = (i * speed) / max(n_frames - 1, 1) * math.pi + phase_shift
        swing = 40 * math.sin(t)
        kp = [[100.0, 50.0, 0.99]] * 5                      # 0-4 head
        kp += [[130 + swing, 100, 0.99], [70 - swing, 100, 0.99]]   # 5,6 shoulders
        kp += [[140 + swing, 140, 0.9], [60 - swing, 140, 0.9]]      # 7,8 elbows
        kp += [[150 + swing, 180, 0.9], [50 - swing, 180, 0.9]]      # 9,10 wrists
        kp += [[120, 200, 0.99], [80, 200, 0.99]]                    # 11,12 hips
        kp += [[122, 260, 0.9], [78, 260, 0.9]]                      # 13,14 knees
        kp += [[124, 320, 0.9], [76, 320, 0.9]]                      # 15,16 ankles
        frames.append({"t": i / 30.0, "i": i, "kp": kp})
    return {"schema": "pose.keypoints.v1", "persons": [{"track_id": 0, "frames": frames}]}


def _run(script, *args):
    return subprocess.run([sys.executable, str(HERE / script), *map(str, args)],
                          capture_output=True, text=True)


def test_align_dtw_phase_aligns_different_speeds(tmp_path):
    """Two swings of different length + speed must produce a monotonic phase-alignment path."""
    s = tmp_path / "s.json"; r = tmp_path / "r.json"; out = tmp_path / "a.json"
    s.write_text(json.dumps(_synthetic_track(30, speed=1.0)))
    r.write_text(json.dumps(_synthetic_track(45, phase_shift=0.6, speed=1.3)))
    res = _run("align_dtw.py", "--student", s, "--reference", r, "--out", out, "--gamma", "0.1")
    assert res.returncode == 0, res.stderr
    a = json.loads(out.read_text())
    assert a["kind"] == "phase_alignment.v1"
    assert a["student_frames"] == 30 and a["reference_frames"] == 45
    path = a["path"]
    assert path[0] == [0, 0] and path[-1] == [29, 44]          # endpoints anchored
    si = [p[0] for p in path]; ri = [p[1] for p in path]
    assert si == sorted(si) and ri == sorted(ri)               # monotonic (no time reversal)
    assert set(range(30)) <= set(si) and set(range(45)) <= set(ri)  # full coverage


def test_align_dtw_fail_closed_on_empty(tmp_path):
    """Degenerate/empty pose track must exit non-zero, never emit a silent alignment."""
    s = tmp_path / "s.json"; r = tmp_path / "r.json"; out = tmp_path / "a.json"
    s.write_text(json.dumps({"persons": []}))
    r.write_text(json.dumps(_synthetic_track(10)))
    res = _run("align_dtw.py", "--student", s, "--reference", r, "--out", out)
    assert res.returncode != 0 and not out.exists()
    assert "REFUSED" in res.stderr


def test_align_dtw_reads_kp_key(tmp_path):
    """The frame keypoint key is `kp` (pose.keypoints.v1), not `keypoints` — regression guard."""
    s = tmp_path / "s.json"; r = tmp_path / "r.json"; out = tmp_path / "a.json"
    s.write_text(json.dumps(_synthetic_track(12)))
    r.write_text(json.dumps(_synthetic_track(12)))
    assert _run("align_dtw.py", "--student", s, "--reference", r, "--out", out).returncode == 0


def test_track_ball_fail_closed_without_weights(tmp_path):
    clip = tmp_path / "c.mp4"; clip.write_bytes(b"\x00")
    res = _run("track_ball.py", "--clip", clip, "--out", tmp_path / "b.json")
    assert res.returncode == 3 and "INSTALL:" in res.stderr        # distinct rc → workflow can branch to fallback


def test_voice_synthesize_fail_closed_without_chatterbox(tmp_path):
    txt = tmp_path / "s.txt"; txt.write_text("coach cue")
    res = _run("voice_synthesize.py", "--text-file", txt, "--out", tmp_path / "v.wav")
    assert res.returncode == 3 and "INSTALL:" in res.stderr


def test_asr_backend_selection_is_data(tmp_path):
    """Unavailable backend is a DATA-selected refusal (rc 3 + install), not a crash."""
    clip = tmp_path / "c.wav"; clip.write_bytes(b"\x00")
    res = _run("asr_transcribe.py", "--clip", clip, "--out", tmp_path / "t.json", "--backend", "parakeet-whisperx")
    assert res.returncode == 3 and "not installed" in res.stderr


if __name__ == "__main__":
    raise SystemExit(subprocess.call([sys.executable, "-m", "pytest", __file__, "-q"]))
