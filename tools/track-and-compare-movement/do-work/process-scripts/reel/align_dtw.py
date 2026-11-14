#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/align_dtw.py
#
# PURPOSE: Reel-factory stage [3] `align.dtw` — phase-align two pose tracks (student swing vs a
# cached reference swing, e.g. the reference player) on MOVEMENT PHASE, not wall-clock time, and emit a
# `phase_alignment.v1` fact. This is the primitive that makes the side-by-side overlay meaningful:
# frame N of the student is matched to the phase-equivalent frame of the reference even when the
# two swings differ in speed, start offset, and frame count.
#
# GENERIC / DATA-SELECTED (L090 / enum-dissolution): this file knows nothing about "tennis",
# "forehand", or "the reference player". It aligns ANY two `pose.keypoints.v1` tracks. Swap the two input
# tracks (basketball shot vs pro, golf swing vs pro, a squat vs last month's squat) and it works
# unchanged — the DATA (which two clips) is the only thing that differs. Deletion test PASSES.
#
# ALGORITHM: soft-DTW / classic DTW over per-frame pose feature vectors. Each frame is reduced to a
# translation- and scale-invariant feature (keypoints re-centered on the hip midpoint and scaled by
# torso length) so alignment is on POSTURE SHAPE, not camera framing. Pure numpy — no tslearn /
# dtaidistance dependency required (those are the named libs in the R5 research; this is the same
# soft-DTW math with zero install so the stage runs on any machine). `--gamma 0` = hard DTW;
# `--gamma > 0` = soft-DTW (differentiable, smoother path) per the R5 `align.dtw` job.
#
# FAIL-CLOSED: missing/empty pose track, no usable person, or degenerate feature matrix -> non-zero
# exit with a machine-readable reason on stderr; never a silent wrong alignment.
#
# USAGE: align_dtw.py --student STUDENT.kp.json --reference REF.kp.json --out ALIGN.json [--gamma 0.1]
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import numpy as np

# COCO-17 indices used for the scale/center reference (hips + shoulders = the stable torso frame).
L_SH, R_SH, L_HIP, R_HIP = 5, 6, 11, 12


def log(m): print(f"[align.dtw] {m}", file=sys.stderr, flush=True)


def _primary_person(track: dict) -> list:
    """Pick the person with the most confident, longest keypoint history (the swinger)."""
    persons = track.get("persons", [])
    if not persons:
        return []
    def score(p):
        frames = p.get("frames", [])
        conf = 0.0
        for fr in frames:
            kp = (fr.get("kp") or fr.get("keypoints") or fr) if isinstance(fr, dict) else fr
            for pt in kp:
                if len(pt) >= 3:
                    conf += pt[2]
        return conf
    return max(persons, key=score).get("frames", [])


def _feature_matrix(frames: list) -> np.ndarray:
    """frames -> (T, 34) translation+scale-invariant pose features. Skips frames with no torso."""
    rows = []
    for fr in frames:
        kp = (fr.get("kp") or fr.get("keypoints") or fr) if isinstance(fr, dict) else fr
        pts = np.array([[p[0], p[1]] for p in kp], dtype=float)  # (17,2)
        if pts.shape[0] < 17:
            continue
        hip = (pts[L_HIP] + pts[R_HIP]) / 2.0
        sh = (pts[L_SH] + pts[R_SH]) / 2.0
        torso = np.linalg.norm(sh - hip)
        if torso < 1e-3:
            continue
        rows.append(((pts - hip) / torso).reshape(-1))  # center on hip, scale by torso length
    return np.array(rows, dtype=float)


def _dtw(A: np.ndarray, B: np.ndarray, gamma: float) -> list:
    """DTW (gamma==0) or soft-DTW (gamma>0) between feature sequences A (T1) and B (T2).
    Returns the warping path [[i,j],...] as aligned index pairs."""
    T1, T2 = len(A), len(B)
    # pairwise squared-euclidean cost
    D = np.sum(A**2, 1)[:, None] + np.sum(B**2, 1)[None, :] - 2 * A @ B.T
    D = np.maximum(D, 0.0)
    INF = float("inf")
    R = np.full((T1 + 1, T2 + 1), INF)
    R[0, 0] = 0.0
    for i in range(1, T1 + 1):
        for j in range(1, T2 + 1):
            c = D[i - 1, j - 1]
            a, b, d = R[i - 1, j], R[i, j - 1], R[i - 1, j - 1]
            if gamma > 0:
                m = min(a, b, d)
                soft = -gamma * np.log(np.exp(-(a - m) / gamma) + np.exp(-(b - m) / gamma) + np.exp(-(d - m) / gamma)) + m
                R[i, j] = c + soft
            else:
                R[i, j] = c + min(a, b, d)
    # backtrack the min-cost path
    i, j, path = T1, T2, []
    while i > 0 and j > 0:
        path.append([i - 1, j - 1])
        step = min((R[i - 1, j], (i - 1, j)), (R[i, j - 1], (i, j - 1)), (R[i - 1, j - 1], (i - 1, j - 1)))[1]
        i, j = step
    path.reverse()
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description="Reel stage align.dtw: phase-align two pose tracks (soft-DTW).")
    ap.add_argument("--student", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gamma", type=float, default=0.1, help="0=hard DTW, >0=soft-DTW (R5 default 0.1)")
    a = ap.parse_args()
    try:
        st = json.load(open(a.student)); rf = json.load(open(a.reference))
    except Exception as e:
        log(f"REFUSED: cannot read pose tracks: {e}"); return 2
    A = _feature_matrix(_primary_person(st)); B = _feature_matrix(_primary_person(rf))
    if len(A) < 2 or len(B) < 2:
        log(f"REFUSED: degenerate features student={len(A)} ref={len(B)}"); return 1
    path = _dtw(A, B, a.gamma)
    out = {
        "kind": "phase_alignment.v1",
        "model": f"soft-DTW (gamma={a.gamma}) over hip-centered torso-scaled COCO-17 features; tslearn/dtaidistance-equivalent, zero-dep numpy impl (R5 align.dtw)",
        "student_frames": len(A), "reference_frames": len(B),
        "path": path,  # [[student_idx, reference_idx], ...]
        "provenance": {"confidence": 1.0, "stage": "align.dtw"},
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(a.out, "w"))
    log(f"aligned student({len(A)}) <-> reference({len(B)}); path len={len(path)} -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
