#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_ball_state_smoother.py
#
# CV03/CV14 acceptance (plan §24.10): prove the dense ball-state smoother on
# SYNTHETIC trajectories with distractor peaks — zero model weights, fully offline.
#   - 60/60 frames get a state (dense, was 13/60 with the old winner-take-all)
#   - the contiguous occlusion window is recovered within tolerance of ground truth
#   - the gated selector rejects distractor peaks (no teleport)
#   - continuity-violation count == 0 (bounded acceleration invariant)
#   - CV14 regression: a PERSISTENT distractor + a one-frame ball dropout does NOT
#     capture the track (the exact failure measured on real TrackNet ground truth,
#     P95 114.9px -> 42.5px once selection gates against the Kalman prediction).
#
# Run: python3 test_ball_state_smoother.py   (plain asserts, exit 0 = pass)

import numpy as np

from ball_state_smoother import select_path_gated, smooth, continuity_violations

RNG = np.random.default_rng(7)  # fixed seed: no Math.random equivalent, reproducible


def ground_truth(n=60):
    """A bouncing-parabola-ish trajectory in image px (one arc)."""
    t = np.arange(n)
    x = 200 + 12.0 * t                      # linear horizontal drift
    y = 600 - (9.0 * t - 0.16 * t * t)      # up-then-down arc
    return np.stack([x, y], axis=1)


def make_candidates(gt, occlude=range(22, 34)):
    """Top-K peaks per frame: the true ball (noisy) + 2 distractors; empty in the
    occlusion window (ball hidden behind a player)."""
    frames = []
    for i, (gx, gy) in enumerate(gt):
        if i in occlude:
            frames.append([])  # fully occluded -> no peaks this frame
            continue
        cands = []
        # true ball with measurement noise + a high score
        cands.append((float(gx + RNG.normal(0, 2)), float(gy + RNG.normal(0, 2)), 0.92))
        # distractor 1: a white line / logo far away, decent score (the teleport trap)
        cands.append((float(gx + RNG.normal(0, 300)), float(gy + RNG.normal(0, 200)), 0.55))
        # distractor 2: a shoe near the baseline
        cands.append((float(120 + RNG.normal(0, 30)), float(940 + RNG.normal(0, 20)), 0.40))
        RNG.shuffle(cands)  # the true ball is NOT always candidate 0
        frames.append(cands)
    return frames


def main():
    gt = ground_truth(60)
    occl = list(range(22, 34))  # 12-frame occlusion
    cands = make_candidates(gt, occlude=occl)

    selected = select_path_gated(cands, accel_noise=4.0, meas_noise_px=2.5)
    states = smooth(selected, accel_noise=4.0, meas_noise_px=2.5, occlusion_gap=5)

    # 1) dense: every frame has a state
    assert len(states) == 60, f"expected 60 states, got {len(states)}"
    known = [s for s in states if s.status != "unknown"]
    assert len(known) == 60, f"all frames should be known (first/last observed); got {len(known)}"

    # 2) the gated selector rejected the far distractors on visible frames -> tracked point
    #    is near ground truth (a teleport to a distractor would be >100px off)
    visible = [i for i in range(60) if i not in occl]
    err_vis = [float(np.hypot(*(np.array(states[i].xy) - gt[i]))) for i in visible]
    p95 = float(np.percentile(err_vis, 95))
    assert p95 <= 12.0, f"visible-frame P95 error {p95:.1f}px exceeds 12px (distractor teleport?)"

    # 3) the occlusion window is RECOVERED (interpolated) within tolerance
    occ_err = [float(np.hypot(*(np.array(states[i].xy) - gt[i]))) for i in occl]
    max_occ = max(occ_err)
    assert max_occ <= 35.0, f"occluded-frame max error {max_occ:.1f}px too high"
    for i in occl:
        assert states[i].status in ("interpolated", "occluded"), states[i].status
        # fail-closed: interpolated/occluded confidence strictly below a clean observed frame
        assert states[i].confidence < 1.0, states[i].confidence

    # 4) bounded acceleration: ZERO continuity violations (no teleport anywhere)
    viols = continuity_violations(states, max_accel_px=40.0)
    assert viols == 0, f"{viols} continuity (teleport) violations"

    # 5) every occluded frame's confidence is below the mean observed confidence
    obs_conf = np.mean([s.confidence for i, s in enumerate(states) if i in visible])
    occ_conf = np.mean([states[i].confidence for i in occl])
    assert occ_conf < obs_conf, f"occluded conf {occ_conf:.3f} !< observed conf {obs_conf:.3f}"

    print("CV03 PASS — dense ball-state smoother")
    print(f"  frames: 60/60 dense (old winner-take-all = 13/60)")
    print(f"  visible P95 error: {p95:.2f}px (<=12)")
    print(f"  12-frame occlusion recovered, max err: {max_occ:.2f}px (<=35)")
    print(f"  continuity (teleport) violations: {viols}")
    print(f"  confidence — observed {obs_conf:.3f} > occluded {occ_conf:.3f} (fail-closed)")


def test_cv14_persistent_distractor_does_not_capture():
    """The EXACT failure measured on real TrackNet ground truth: the true ball
    drops out for one frame while a PERSISTENT bright blob sits at a fixed point.
    The old flat-cost-miss Viterbi jumped onto the blob and stayed (~490px lock);
    the gated selector coasts the Kalman prediction across the dropout and rejects
    the off-prediction blob, so the track stays on the true ball."""
    gt = ground_truth(60)
    blob = (1080.0, 200.0)  # a fixed scene object far from the true arc
    frames = []
    for i, (gx, gy) in enumerate(gt):
        cands = []
        # ball is acquired first (frames 0-9 ball-only), then the blob enters and
        # PERSISTENTLY OUTSCORES the ball (0.73 > 0.66) — exactly real f172, where
        # the gate (not the score) must keep the track on the ball.
        if i not in (28, 29):                              # true ball missing on 28-29 (dropout)
            cands.append((float(gx), float(gy), 0.66))
        if i >= 10:
            cands.append((blob[0], blob[1], 0.73))         # higher-scoring persistent distractor
        RNG.shuffle(cands)
        frames.append(cands)

    selected = select_path_gated(frames, accel_noise=4.0, meas_noise_px=2.5)
    states = smooth(selected, accel_noise=4.0, meas_noise_px=2.5, occlusion_gap=5)

    # the track must NEVER sit on the blob: every frame's state stays near the true arc
    blob_locks = sum(1 for i in range(60)
                     if np.hypot(states[i].xy[0] - blob[0], states[i].xy[1] - blob[1]) < 100.0)
    assert blob_locks == 0, f"track captured by persistent distractor on {blob_locks} frames"
    # and the post-dropout frames re-acquire the true ball (not the higher-scoring blob)
    for i in (30, 31, 32):
        err = float(np.hypot(states[i].xy[0] - gt[i][0], states[i].xy[1] - gt[i][1]))
        assert err < 25.0, f"frame {i} err {err:.1f}px — did not re-acquire the true ball"
    print("CV14 PASS — persistent distractor + ball dropout does NOT capture the track")
    print(f"  blob-lock frames: 0/60; true ball re-acquired after the dropout")


def test_cv14c_court_gate_rejects_off_court_blob():
    """CV14c: an injected court-region `accept` predicate removes an off-court blob
    BEFORE selection, so even when the ball drops out and the blob is the only
    candidate, the tracker coasts (rejects the blob) instead of locking it — the
    exact win measured on real TrackNet (game5 P95 397 → 67px). Mirrors the filter
    `infer_frames` applies: cand = [c for c in cand if accept(i, (c[0], c[1]))]."""
    gt = ground_truth(60)
    blob = (1080.0, 200.0)                                  # off-court (stands/scoreboard)
    raw = []
    for i, (gx, gy) in enumerate(gt):
        cands = [(blob[0], blob[1], 0.85)]                 # persistent HIGH-score off-court blob
        if i not in range(24, 30):                          # ball absent 24-29 (only the blob remains)
            cands.append((float(gx), float(gy), 0.66))
        RNG.shuffle(cands)
        raw.append(cands)

    # injected court gate: reject anything to the right of the court (x > 900)
    accept = lambda frame, xy: xy[0] <= 900.0
    gated = [[c for c in cs if accept(i, (c[0], c[1]))] for i, cs in enumerate(raw)]

    selected = select_path_gated(gated, accel_noise=4.0, meas_noise_px=2.5)
    states = smooth(selected, accel_noise=4.0, meas_noise_px=2.5, occlusion_gap=5)
    blob_locks = sum(1 for i in range(60)
                     if np.hypot(states[i].xy[0] - blob[0], states[i].xy[1] - blob[1]) < 100.0)
    assert blob_locks == 0, f"off-court blob captured the track on {blob_locks} frames despite the gate"
    # ball tracked on visible frames (gate kept the on-court true ball)
    vis = [i for i in range(60) if i not in range(24, 30)]
    err = [float(np.hypot(states[i].xy[0] - gt[i][0], states[i].xy[1] - gt[i][1])) for i in vis]
    p95 = float(np.percentile(err, 95))
    assert p95 <= 12.0, f"visible P95 {p95:.1f}px — gate or selection wrong"
    print("CV14c PASS — court-region gate rejects the off-court blob (no lock, ball tracked)")
    print(f"  blob-lock frames: 0/60; visible P95 {p95:.2f}px")


if __name__ == "__main__":
    main()
    test_cv14_persistent_distractor_does_not_capture()
    test_cv14c_court_gate_rejects_off_court_blob()
