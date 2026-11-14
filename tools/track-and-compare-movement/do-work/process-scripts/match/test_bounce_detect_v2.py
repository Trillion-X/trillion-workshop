#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_bounce_detect_v2.py
#
# CV05 acceptance (plan §24.10): prove the two-segment/BIC bounce detector on
# synthetic trajectories — pure, offline, zero weights.
#   - a trajectory with ONE real bounce -> detected within +-1 frame, posterior >= 0.90
#   - a SMOOTH no-bounce trajectory -> ZERO bounces (fail-closed; noise alone
#     never wins BIC)
#   - the legacy CatBoost vote, when supplied, raises but does not solely create
#     a detection
#
# Run: python3 test_bounce_detect_v2.py

import numpy as np

from bounce_detect_v2 import detect_bounces

RNG = np.random.default_rng(11)


def bouncing_track(n=40, bounce_frame=20, noise=0.6):
    """Image-space track: ball descends (y increases), bounces at `bounce_frame`
    (y-velocity flips sign), then ascends. x drifts steadily."""
    track = []
    for f in range(n):
        x = 100 + 8.0 * f + RNG.normal(0, noise)
        if f <= bounce_frame:
            y = 200 + 10.0 * f + RNG.normal(0, noise)          # descending
        else:
            y_at_b = 200 + 10.0 * bounce_frame
            y = y_at_b - 9.0 * (f - bounce_frame) + RNG.normal(0, noise)  # ascending
        track.append((f, x, y))
    return track


def smooth_track(n=40, noise=0.6):
    """A single straight-velocity trajectory — NO bounce."""
    return [(f, 100 + 8.0 * f + RNG.normal(0, noise),
             200 + 6.0 * f + RNG.normal(0, noise)) for f in range(n)]


def main():
    # 1) one real bounce -> detected near frame 20
    track = bouncing_track(40, bounce_frame=20)
    bounces = detect_bounces(track, posterior_threshold=0.90)
    assert len(bounces) >= 1, "no bounce detected on a clearly-bouncing track"
    nearest = min(bounces, key=lambda b: abs(b.frame - 20))
    assert abs(nearest.frame - 20) <= 1, f"bounce frame {nearest.frame} not within +-1 of 20"
    assert nearest.event_confidence >= 0.90, f"posterior {nearest.event_confidence} < 0.90"
    assert nearest.velocity_angle_change_deg > 25.0, nearest

    # exactly one bounce after NMS (no duplicate spam)
    assert len(bounces) == 1, f"expected 1 bounce, got {len(bounces)} at {[b.frame for b in bounces]}"

    # 2) smooth track -> ZERO bounces (fail-closed under noise)
    smooth = smooth_track(40)
    assert detect_bounces(smooth, posterior_threshold=0.90) == [], "false bounce on smooth track"

    # 3) CatBoost vote folds in (raises posterior) but is not sole authority:
    #    on the smooth track even a strong CatBoost vote must NOT manufacture a
    #    bounce, because BIC gain + angle gates still fail.
    votes = {f: 0.99 for f in range(40)}
    assert detect_bounces(smooth, catboost_votes=votes, posterior_threshold=0.90) == [], \
        "CatBoost vote alone fabricated a bounce — must require trajectory evidence"

    # 4) court-plane gate: an injected accept() predicate rejects an off-court
    #    inflection (the bounce leaf stays court-agnostic — predicate injected).
    track2 = bouncing_track(40, bounce_frame=20)
    keep = detect_bounces(track2, posterior_threshold=0.90, accept=lambda f, xy: True)
    assert len(keep) == 1, "accept=all must keep the real bounce"
    detected_frame = keep[0].frame
    # reject the whole bounce REGION (the velocity break spans several frames, so
    # rejecting one would let a neighbouring candidate through) — simulates "this
    # area projects off-court".
    rejected = detect_bounces(track2, posterior_threshold=0.90,
                              accept=lambda f, xy: abs(f - detected_frame) > 3)
    assert rejected == [], "accept predicate must filter the off-court bounce region"

    print("CV05 PASS — two-segment/BIC bounce detector")
    print(f"  bounce detected at frame {nearest.frame} (truth 20), posterior {nearest.event_confidence}")
    print(f"  velocity-angle change: {nearest.velocity_angle_change_deg:.1f}°, BIC gain {nearest.model_votes['two_segment_bic_gain']}")
    print(f"  smooth track: 0 bounces (fail-closed)")
    print(f"  CatBoost vote cannot fabricate a bounce without trajectory evidence ✓")
    print("  NOTE: real-world P/R needs labeled Ethos points (CV05 live gate); this proves the MECHANISM.")


if __name__ == "__main__":
    main()
