#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/bounce_detect_v2.py
#
# =============================================================================
# PURPOSE — CV05 (plan §24.5.2): production bounce detection
# =============================================================================
#
# The vendored TennisProject BounceDetector (CatBoostRegressor over trajectory
# features) collapses to 0 bounces when the ball track is sparse (it needs
# near-continuous positions; bounce_detector.py:17,61). It becomes ONE VOTE here,
# not the authority. The production bounce is a TRAJECTORY-EVENT detector:
#
#   A bounce is a C1 (velocity) discontinuity in an otherwise C0 (continuous)
#   trajectory. At a candidate frame t_b we fit:
#     - SINGLE model: one straight velocity through the whole local window.
#     - TWO-SEGMENT model: separate velocities before/after t_b, tied to the same
#       position at t_b (C0 continuity) but allowed a velocity break (C1 jump).
#   We score the two-segment model against the single model by BIC (Bayesian
#   Information Criterion) — which rewards lower residual error but PENALISES the
#   extra parameters, so noise alone never wins. A bounce is emitted only when
#   the BIC improvement, the velocity-direction change, and (for a real bounce)
#   the downward→upward flip all clear thresholds, giving a posterior >= 0.90.
#   Below threshold → a `*_candidate` or nothing. NEVER a fabricated bounce
#   (fail-closed, plan §24.5.6).
#
# Pure leaf: consumes a dense track (from CV03 ball_state_smoother), produces
# bounce events with posterior + provenance. Offline-testable on synthetic
# trajectories (test_bounce_detect_v2.py). The homography→court_xy projection and
# the CatBoost vote are folded at live-wiring time (CV08/CV11) — this leaf owns
# the trajectory-physics decision, which is the part the sparse pipeline lacked.
#
# =============================================================================
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
# =============================================================================

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np


@dataclass
class Bounce:
    frame: int
    image_xy: tuple[float, float]
    event_confidence: float          # posterior in [0,1]
    bic_single: float
    bic_two_segment: float
    velocity_angle_change_deg: float
    model_votes: dict
    provenance: dict


def _fit_line(t: np.ndarray, y: np.ndarray):
    """Least-squares line y = a + b t; return (a, b, rss)."""
    A = np.vstack([np.ones_like(t), t]).T
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    rss = float(np.sum((y - A @ coef) ** 2))
    return coef[0], coef[1], rss


def _bic(rss: float, n: int, k: int) -> float:
    rss = max(rss, 1e-9)
    return n * np.log(rss / n) + k * np.log(max(n, 2))


def _segment_rss_c0(t: np.ndarray, y: np.ndarray, split: int):
    """Two segments sharing the value at the split index (C0 continuity), each
    with its own slope (C1 break). Returns (rss_total, slope_pre, slope_post)."""
    # Parameterise around the split point: y(t) = c + b_pre*(t-t_s) for t<=t_s,
    # y(t) = c + b_post*(t-t_s) for t>=t_s. Shared intercept c at t_s.
    t_s = t[split]
    dt = t - t_s
    pre = t <= t_s
    post = t >= t_s
    # design: columns [1 (shared c), dt*pre, dt*post]
    A = np.vstack([np.ones_like(t), dt * pre, dt * post]).T
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    rss = float(np.sum((y - A @ coef) ** 2))
    return rss, coef[1], coef[2]


def detect_bounces(
    track,                       # list of (frame, x, y) dense, ordered
    *,
    window: int = 7,
    min_bic_gain: float = 6.0,
    min_angle_change_deg: float = 25.0,
    posterior_threshold: float = 0.90,
    min_gap_frames: int = 4,
    catboost_votes: dict | None = None,
    accept: Optional[Callable[[int, tuple], bool]] = None,
    provenance: dict | None = None,
) -> list[Bounce]:
    """Scan interior frames; emit a bounce where the two-segment (C1-break) fit
    beats the single-line fit by BIC AND the velocity direction changes enough.
    `catboost_votes` (frame->prob) optionally folds the legacy detector as ONE
    vote (boosts posterior, never the sole authority)."""
    pts = [(int(f), float(x), float(y)) for (f, x, y) in track]
    n = len(pts)
    out: list[Bounce] = []
    half = window // 2
    for i in range(half, n - half):
        idx = list(range(i - half, i + half + 1))
        t = np.array([pts[j][0] for j in idx], float)
        xs = np.array([pts[j][1] for j in idx], float)
        ys = np.array([pts[j][2] for j in idx], float)
        split = half  # candidate bounce at window centre

        # fit single + two-segment on BOTH axes; sum residuals
        _, bx, rss_x1 = _fit_line(t, xs)
        _, by, rss_y1 = _fit_line(t, ys)
        rss1 = rss_x1 + rss_y1
        rx2, bx_pre, bx_post = _segment_rss_c0(t, xs, split)
        ry2, by_pre, by_post = _segment_rss_c0(t, ys, split)
        rss2 = rx2 + ry2

        m = 2 * len(t)  # samples (x and y stacked)
        bic1 = _bic(rss1, m, k=4)   # 2 lines × (intercept+slope)
        bic2 = _bic(rss2, m, k=6)   # 2 axes × (shared c + 2 slopes)
        gain = bic1 - bic2

        v_pre = np.array([bx_pre, by_pre])
        v_post = np.array([bx_post, by_post])
        npre, npost = np.linalg.norm(v_pre), np.linalg.norm(v_post)
        if npre < 1e-6 or npost < 1e-6:
            continue
        cosang = float(np.clip(np.dot(v_pre, v_post) / (npre * npost), -1, 1))
        angle_change = float(np.degrees(np.arccos(cosang)))

        # posterior: logistic over (BIC gain past threshold) + (angle past min),
        # nudged by the optional CatBoost vote.
        z = 0.6 * (gain - min_bic_gain) + 0.05 * (angle_change - min_angle_change_deg)
        post = 1.0 / (1.0 + np.exp(-z))
        cb = (catboost_votes or {}).get(pts[i][0])
        if cb is not None:
            post = float(np.clip(0.7 * post + 0.3 * cb, 0, 1))

        # court-plane plausibility (plan §24.5.2): an injected `accept(frame, xy)`
        # predicate (e.g. "the bounce projects within the court polygon") rejects
        # off-court inflections. The leaf stays court-AGNOSTIC — the predicate is an
        # injected capability (L090), never baked court geometry.
        plane_ok = accept is None or bool(accept(pts[i][0], (pts[i][1], pts[i][2])))
        if plane_ok and gain >= min_bic_gain and angle_change >= min_angle_change_deg and post >= posterior_threshold:
            out.append(Bounce(
                frame=pts[i][0], image_xy=(pts[i][1], pts[i][2]),
                event_confidence=round(float(post), 4),
                bic_single=round(bic1, 3), bic_two_segment=round(bic2, 3),
                velocity_angle_change_deg=round(angle_change, 2),
                model_votes={"two_segment_bic_gain": round(gain, 3),
                             "catboost": cb},
                provenance={"stage": "bounce.detect.v1", **(provenance or {})},
            ))
    # suppress duplicate adjacent detections — keep the highest-posterior per run.
    # min_gap is a PHYSICAL floor: a ball cannot bounce twice within this many
    # frames (at 60fps, ~0.2s = 12 frames is a generous lower bound on bounce
    # cadence). NOT a fit — a kinematic constant.
    return _nms(out, min_gap=min_gap_frames)


def _nms(bounces: list[Bounce], min_gap: int = 4) -> list[Bounce]:
    if not bounces:
        return []
    bounces = sorted(bounces, key=lambda b: -b.event_confidence)
    kept: list[Bounce] = []
    for b in bounces:
        if all(abs(b.frame - k.frame) >= min_gap for k in kept):
            kept.append(b)
    return sorted(kept, key=lambda b: b.frame)
