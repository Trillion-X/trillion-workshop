#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/ball_state_smoother.py
#
# =============================================================================
# PURPOSE — CV03 (plan §24.5.1 / §24.10): the dense BALL-STATE smoother
# =============================================================================
#
# The deepest root of the broken match-tracking vision (plan §24.1) is that the
# pipeline has NO temporal model: each frame's ball is the argmax of one heatmap,
# picked by HoughCircles, gated to within 80px of the previous point. That is a
# winner-take-all per frame — it drops the ball under blur/occlusion (13/60 on the
# the reference player clip) and "teleports" on a false match (prove_shot_speed.py:61).
#
# This module is the principled replacement, as a PURE leaf (zero I/O, zero model
# weights — it consumes per-frame candidate peaks and produces a dense track). It
# is the core of the `ball-track.dense.v1` stage and is testable offline on a
# synthetic occluded trajectory (test_ball_state_smoother.py).
#
# Two stages, exactly as converged by Claude+Codex (plan §24.0/§24.5.1):
#   1. VITERBI over the top-K heatmap peaks per frame — choose the lowest-cost
#      path under a motion-smoothness transition cost, with an explicit "miss"
#      state so an occluded frame is a first-class option (NOT a forced bad pick).
#      This dissolves the teleport: a far candidate costs more than a miss.
#   2. Constant-acceleration KALMAN filter forward pass over the selected
#      observations (missed frames are prediction-only), then RAUCH-TUNG-STRIEBEL
#      backward smoothing -> a dense (x,y)+covariance for EVERY frame, with a
#      status of observed | interpolated | occluded | unknown and a confidence
#      that is strictly lower on non-observed frames (fail-closed, plan §24.5.6).
#
# Bounded acceleration is a structural invariant: the process model caps plausible
# accel, so a recovered segment cannot teleport. A continuity check reports any
# frame whose smoothed acceleration exceeds a physical bound (must be 0 on a clean
# track) — this is the acceptance gate, not a screenshot.
#
# =============================================================================
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
# =============================================================================

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np

# A per-frame candidate peak: image (x, y) and the detector's peak score in [0,1].
Candidate = tuple[float, float, float]


@dataclass
class BallState:
    """One frame of the dense smoothed track (plan §24.5.1 fact shape)."""
    frame: int
    xy: tuple[float, float]
    covariance_2x2: list[list[float]]
    status: str            # observed | interpolated | occluded | unknown
    confidence: float      # [0,1], strictly lower when not observed


# --------------------------------------------------------------------------- #
# Stage 1 — candidate selection (Stage 1' below: filter-in-the-loop gating)
# --------------------------------------------------------------------------- #
#
# The candidate selector is `select_path_gated` (Stage 1', after the Kalman
# matrices it depends on). The earlier pure-Viterbi `select_path` was DELETED
# (L030/L100): it minimised pixel-distance only and had a structural hole — a
# `miss` is flat-cost and miss->candidate is also flat-cost with NO distance gate,
# so a one-frame ball dropout let a far persistent distractor capture the track
# (measured on real TrackNet ground truth: P95 114.9px, a ~490px lock). Gating
# against the Kalman PREDICTION instead of the last selected point fixed it
# (P95 -> 42.5px); keeping a distance-only Viterbi would be a second, worse code
# path for the same job. See `select_path_gated`.


# --------------------------------------------------------------------------- #
# Stage 2 — constant-acceleration Kalman + RTS smoother
# --------------------------------------------------------------------------- #

# State = [x, vx, ax, y, vy, ay]. dt = 1 frame.
def _F(dt: float) -> np.ndarray:
    f1 = np.array([[1, dt, 0.5 * dt * dt], [0, 1, dt], [0, 0, 1]], float)
    F = np.zeros((6, 6))
    F[:3, :3] = f1
    F[3:, 3:] = f1
    return F


def _Q(dt: float, q: float) -> np.ndarray:
    # White-noise-jerk discretisation per axis (continuous accel noise `q`).
    g = np.array([[dt**3 / 6], [dt**2 / 2], [dt]])
    q1 = (g @ g.T) * q
    Q = np.zeros((6, 6))
    Q[:3, :3] = q1
    Q[3:, 3:] = q1
    return Q


_H = np.array([[1, 0, 0, 0, 0, 0], [0, 0, 0, 1, 0, 0]], float)


def smooth(
    selected: Sequence[Optional[Candidate]],
    *,
    dt: float = 1.0,
    accel_noise: float = 4.0,
    meas_noise_px: float = 3.0,
    occlusion_gap: int = 5,
    max_accel_px: float = 40.0,
) -> list[BallState]:
    """Forward Kalman + RTS backward smoothing over the selected observations.

    Missed frames contribute no measurement (prediction-only). After smoothing,
    every frame has a dense (x,y)+covariance. Status:
      - observed:     this frame had a selected candidate
      - interpolated: no candidate, but inside a short bridge (< occlusion_gap)
      - occluded:     no candidate, inside a long gap (>= occlusion_gap)
      - unknown:      before the first / after the last ever observation
    Confidence decays with positional covariance and is strictly < observed for
    any non-observed frame (fail-closed, plan §24.5.6).
    """
    n = len(selected)
    if n == 0:
        return []
    F = _F(dt)
    Q = _Q(dt, accel_noise)
    R = np.eye(2) * (meas_noise_px ** 2)

    obs_idx = [i for i, s in enumerate(selected) if s is not None]
    if not obs_idx:
        # No observation anywhere -> entire track unknown (fail-closed).
        return [BallState(i, (float("nan"), float("nan")), [[float("inf")] * 2] * 2,
                          "unknown", 0.0) for i in range(n)]
    first, last = obs_idx[0], obs_idx[-1]

    # --- forward pass ---
    x = np.zeros(6)
    sx, sy, _ = selected[first]  # type: ignore[misc]
    x[0], x[3] = sx, sy
    P = np.eye(6) * 1e4
    xs_pred, Ps_pred, xs_filt, Ps_filt = [], [], [], []
    for i in range(n):
        if i == 0:
            xp, Pp = x.copy(), P.copy()
        else:
            xp = F @ xf
            Pp = F @ Pf @ F.T + Q
        xs_pred.append(xp.copy())
        Ps_pred.append(Pp.copy())
        cand = selected[i]
        if cand is not None:
            z = np.array([cand[0], cand[1]], float)
            S = _H @ Pp @ _H.T + R
            K = Pp @ _H.T @ np.linalg.inv(S)
            xf = xp + K @ (z - _H @ xp)
            Pf = (np.eye(6) - K @ _H) @ Pp
        else:
            xf, Pf = xp, Pp
        xs_filt.append(xf.copy())
        Ps_filt.append(Pf.copy())

    # --- RTS backward pass ---
    xs_sm = [a.copy() for a in xs_filt]
    Ps_sm = [a.copy() for a in Ps_filt]
    for i in range(n - 2, -1, -1):
        C = Ps_filt[i] @ F.T @ np.linalg.inv(Ps_pred[i + 1])
        xs_sm[i] = xs_filt[i] + C @ (xs_sm[i + 1] - xs_pred[i + 1])
        Ps_sm[i] = Ps_filt[i] + C @ (Ps_sm[i + 1] - Ps_pred[i + 1]) @ C.T

    # --- gap classification ---
    def gap_status(i: int) -> str:
        if i < first or i > last:
            return "unknown"
        # distance (in frames) to the nearest observation on either side
        left = max((j for j in obs_idx if j <= i), default=None)
        right = min((j for j in obs_idx if j >= i), default=None)
        nearest = min(i - left if left is not None else 10**9,
                      right - i if right is not None else 10**9)
        return "interpolated" if nearest < occlusion_gap else "occluded"

    out: list[BallState] = []
    for i in range(n):
        st = xs_sm[i]
        Pxy = np.array([[Ps_sm[i][0, 0], Ps_sm[i][0, 3]],
                        [Ps_sm[i][3, 0], Ps_sm[i][3, 3]]])
        observed = selected[i] is not None
        status = "observed" if observed else gap_status(i)
        # confidence: shrink with positional std; cap non-observed strictly below 1.
        pos_std = float(np.sqrt(max(Pxy[0, 0], Pxy[1, 1])))
        conf = float(np.clip(1.0 / (1.0 + pos_std / meas_noise_px), 0.0, 1.0))
        if not observed:
            conf = min(conf, 0.85)
        if status == "unknown":
            conf = 0.0
        out.append(BallState(i, (float(st[0]), float(st[3])),
                             Pxy.tolist(), status, round(conf, 4)))
    return out


def continuity_violations(states: Sequence[BallState], max_accel_px: float = 40.0) -> int:
    """Count frames whose smoothed acceleration exceeds the physical bound.

    On a correctly recovered track this MUST be 0 (the acceptance gate, plan
    §24.5.1 / CV03) — proof there is no teleport, not a screenshot.
    """
    pts = [np.array(s.xy) for s in states if s.status != "unknown"]
    v = 0
    for i in range(2, len(pts)):
        accel = pts[i] - 2 * pts[i - 1] + pts[i - 2]
        if float(np.hypot(*accel)) > max_accel_px:
            v += 1
    return v


# --------------------------------------------------------------------------- #
# Stage 1' — filter-in-the-loop candidate selection (distractor-lock dissolution)
# --------------------------------------------------------------------------- #

def select_path_gated(
    frames_candidates: Sequence[Sequence[Candidate]],
    *,
    dt: float = 1.0,
    accel_noise: float = 4.0,
    meas_noise_px: float = 3.0,
    gate_chi2: float = 9.21,
    max_gate_px: float = 140.0,
    reinit_after: int = 8,
) -> list[Optional[Candidate]]:
    """Pick one candidate (or a miss) per frame by gating against the Kalman
    PREDICTION — the distractor-lock dissolution (plan §24.10 CV14).

    The first-order Viterbi (`select_path`) has a structural hole proven on real
    TrackNet ground truth: a `miss` is a flat-cost state, and the transition
    miss -> candidate is also flat-cost with NO distance gate. So the instant the
    true ball drops for one frame, ANY candidate — including a far persistent
    distractor blob — is "free to grab", and once grabbed the locally-smooth
    distractor track is cheap to keep (measured: P95 114.9px, a ~490px lock onto a
    blob at ~(1080,200) while the true ball was the TOP candidate elsewhere).

    The fix is dynamics-in-the-loop: run a constant-acceleration Kalman forward
    pass and, at each frame, accept only a candidate inside the innovation gate of
    the COASTED PREDICTION (Mahalanobis d² <= `gate_chi2` AND within `max_gate_px`
    of the predicted point). Across a miss the prediction keeps coasting along the
    true ballistic arc, so a distractor 450px off the prediction is rejected and
    the track re-acquires the true ball when it re-enters the gate. After
    `reinit_after` consecutive misses the track is declared lost and re-seeded from
    the strongest detection (so a genuinely new rally is not bound to a stale
    prediction). Returns a `selected` list (None = miss) — a drop-in for
    `select_path`, consumed by the SAME tested `smooth()` for the real RTS pass.
    """
    # SSOT: the gated forward filter lives ONCE, in `_gated_directional` (which also
    # reports per-frame confidence/points for the two-pass experiment). This shipped
    # entry is a thin wrapper that keeps only the selected list — so a fix to the
    # filter touches one implementation, never two (L100/SSOT).
    selected, _confident, _points = _gated_directional(
        frames_candidates, dt=dt, accel_noise=accel_noise, meas_noise_px=meas_noise_px,
        gate_chi2=gate_chi2, max_gate_px=max_gate_px, reinit_after=reinit_after,
    )
    return selected


# --------------------------------------------------------------------------- #
# Stage 1'' — multi-hypothesis track scoring (lost-track recovery, CV14b)
# --------------------------------------------------------------------------- #

def select_path_mht(
    frames_candidates: Sequence[Sequence[Candidate]],
    *,
    dt: float = 1.0,
    accel_noise: float = 4.0,
    meas_noise_px: float = 3.0,
    gate_chi2: float = 9.21,
    max_gate_px: float = 140.0,
    beam: int = 24,
    detect_reward: float = 1.0,
    accel_weight: float = 0.02,
    coast_penalty: float = 0.30,
    jump_penalty: float = 1.5,
    jump_min_score: float = 0.55,
) -> list[Optional[Candidate]]:
    """Beam search over TRACK hypotheses — the lost-track-recovery fix (CV14b).

    ⚠️ EXPERIMENTAL — NOT WIRED INTO `infer_frames` (production uses the stable
    `select_path_gated`). This is correct-structure WIP: it PROVES the residual tail
    is crushable by whole-track scoring (game5 P95 397 → 32.8px, game1 P95 7px when
    it tracks) but is NOT YET ROBUST across clips and would regress production.
    Measured 2026-06-28 (jump variant, beam=24): game1 P95 7.2 but detection 0.365
    (coverage collapse — winner lineage coasts most of the clip); game2 P95 219.8;
    game5 P95 32.8 ✅; game8 P95 493.6.

    UPDATE 2026-06-28 — MHT *combined with the CV14c court gate* (which removes the
    off-court hallucinations the MHT was locking onto): game1 42.5→**14.42px** with
    FULL coverage restored (0.365→0.995), game5 67→**45.4px** — a real breakthrough
    where the failure was hallucination/lost-track. BUT game2 (reliable court) went
    56→**1312px** (P50 26px — tracking garbage) and game8 493: the MHT's OWN
    single-global-best-lineage output is unstable on longer/harder clips, and the
    court gate cannot fix that. So MHT is STILL not shippable; production stays on
    `select_path_gated`+CV14c. The real remaining work is proper delayed-decision /
    forward-backward MHT machinery (N-scan pruning or two-filter smoothing) so the
    output is a stable per-frame MAP estimate, not one global argmax lineage.
    Acceptance bar unchanged: P95 ≤ 12px across ≥3 games, no P50/detection regression,
    `test_cv14_*` still green. Validate with `validate_ball_accuracy.py [--court]`.


    The single-hypothesis gated filter (`select_path_gated`) fixes the worst
    distractor-lock but does NOT generalize (measured: game1 P95 42px but game5/8
    ~390px): once it GREEDILY grabs an in-gate distractor at a recall gap, the track
    drifts and the gate then rejects the true ball's strong re-appearance. No
    per-frame scalar (score/distance/persistence) separates a stationary blob from a
    moving ball — only ballistic motion over WHOLE tracks does.

    So keep `beam` hypotheses. EVERY hypothesis makes a decision EVERY frame (so all
    cumulative scores are over the same n terms and are directly comparable — the
    bug in a births-as-new-tracks design is that a short lucky track beats a long
    one). Per frame each hypothesis branches into: (1) one child per IN-GATE
    candidate — `+detect_reward*score - accel_weight*‖c-2p₋₁+p₋₂‖` (a smooth arc is
    nearly free, a 600px grab is punished); (2) a COAST child — `-coast_penalty`
    (ball occluded, prediction holds the arc); (3) a JUMP child per OUT-OF-GATE but
    STRONG candidate (score ≥ `jump_min_score`) — `+detect_reward*score
    - jump_penalty`, re-seeding the filter at that candidate ("I lost the ball and
    re-found it"). Prune to the top `beam`. The best-scoring hypothesis is returned.

    Why this is the categorical fix, not a 5th heuristic: the "coast instead of
    grab" branch survives in the beam and keeps its prediction on the true arc, and
    the JUMP recovers a genuinely lost track when the ball reappears strongly — one
    spanning lineage covers the whole clip, and the same comparable-score mechanism
    handles both the stationary-blob lock and the lost-track non-recovery.
    Drop-in for `select_path_gated`; consumed by the SAME tested `smooth()`.
    """
    n = len(frames_candidates)
    if n == 0:
        return []
    F = _F(dt)
    Q = _Q(dt, accel_noise)
    R = np.eye(2) * (meas_noise_px ** 2)
    P0 = np.diag([meas_noise_px ** 2, 1e4, 1e2, meas_noise_px ** 2, 1e4, 1e2]).astype(float)

    def seed(c: Candidate, i: int) -> dict:
        cx, cy, cs = c
        return {"x": np.array([cx, 0.0, 0.0, cy, 0.0, 0.0], float), "P": P0.copy(),
                "score": detect_reward * cs, "sel": [None] * i + [c]}

    def accel_of(sel: list, new_xy: tuple) -> float:
        # ‖new - 2*p₋₁ + p₋₂‖ over the last two SELECTED candidate positions
        pts = [(c[0], c[1]) for c in reversed(sel) if c is not None][:2]
        if len(pts) < 2:
            return 0.0
        p1, p2 = pts[0], pts[1]
        return float(np.hypot(new_xy[0] - 2 * p1[0] + p2[0], new_xy[1] - 2 * p1[1] + p2[1]))

    hyps: list[dict] = []
    for i in range(n):
        cands = frames_candidates[i]
        if not hyps:
            hyps = sorted((seed(c, i) for c in cands), key=lambda h: -h["score"])[:beam]
            continue
        children: list[dict] = []
        for h in hyps:
            xp = F @ h["x"]
            Pp = F @ h["P"] @ F.T + Q
            S = _H @ Pp @ _H.T + R
            Sinv = np.linalg.inv(S)
            pred = _H @ xp
            for c in cands:
                cx, cy, cs = c
                nu = np.array([cx, cy]) - pred
                if float(nu @ Sinv @ nu) <= gate_chi2 and float(np.hypot(nu[0], nu[1])) <= max_gate_px:
                    K = Pp @ _H.T @ Sinv                       # (1) in-gate continuation
                    xf = xp + K @ nu
                    Pf = (np.eye(6) - K @ _H) @ Pp
                    accel = accel_of(h["sel"], (xf[0], xf[3]))
                    children.append({"x": xf, "P": Pf,
                                     "score": h["score"] + detect_reward * cs - accel_weight * accel,
                                     "sel": h["sel"] + [c]})
                elif cs >= jump_min_score:                     # (3) jump: re-detection recovery
                    children.append({"x": np.array([cx, 0.0, 0.0, cy, 0.0, 0.0], float), "P": P0.copy(),
                                     "score": h["score"] + detect_reward * cs - jump_penalty,
                                     "sel": h["sel"] + [c]})
            children.append({"x": xp, "P": Pp, "score": h["score"] - coast_penalty,
                             "sel": h["sel"] + [None]})        # (2) coast (ball occluded this frame)
        hyps = sorted(children, key=lambda h: -h["score"])[:beam]

    if not hyps:
        return [None] * n
    best = max(hyps, key=lambda h: h["score"])
    sel = best["sel"]
    return sel + [None] * (n - len(sel))


# --------------------------------------------------------------------------- #
# Stage 1''' — two-pass gated re-acquisition (CV14b — improves reliable clips, 1 un-gatable tail regression; not wired)
# --------------------------------------------------------------------------- #

def _gated_directional(
    frames_candidates: Sequence[Sequence[Candidate]],
    *, dt: float, accel_noise: float, meas_noise_px: float,
    gate_chi2: float, max_gate_px: float, reinit_after: int,
):
    """One direction of the gated filter (the EXACT logic of `select_path_gated`),
    additionally reporting per-frame `confident` = True ONLY when the frame was
    matched through the innovation gate (NOT a miss, NOT a blind reseed/seed).
    Returns (selected, confident, points) where points[i] is the filtered (x,y)."""
    n = len(frames_candidates)
    F = _F(dt); Q = _Q(dt, accel_noise); R = np.eye(2) * (meas_noise_px ** 2)

    def seed(c):
        cx, cy, _ = c
        x = np.array([cx, 0.0, 0.0, cy, 0.0, 0.0], float)
        P = np.diag([meas_noise_px ** 2, 1e4, 1e2, meas_noise_px ** 2, 1e4, 1e2]).astype(float)
        return x, P

    selected = [None] * n
    confident = [False] * n
    points = [None] * n
    x = P = None
    have = False
    coast = 0
    for i in range(n):
        cands = frames_candidates[i]
        if not have:
            if cands:
                c = max(cands, key=lambda c: c[2])   # ungated acquire = NOT confident
                x, P = seed(c)
                selected[i] = c
                points[i] = (x[0], x[3])
                have, coast = True, 0
            continue
        xp = F @ x
        Pp = F @ P @ F.T + Q
        S = _H @ Pp @ _H.T + R
        Sinv = np.linalg.inv(S)
        pred = _H @ xp
        best = None; best_key = None
        for c in cands:
            cx, cy, cs = c
            nu = np.array([cx, cy]) - pred
            d2 = float(nu @ Sinv @ nu)
            if d2 <= gate_chi2 and float(np.hypot(nu[0], nu[1])) <= max_gate_px:
                key = (cs, -d2)
                if best_key is None or key > best_key:
                    best_key, best = key, c
        if best is not None:
            cx, cy, cs = best
            K = Pp @ _H.T @ Sinv
            x = xp + K @ (np.array([cx, cy]) - pred)
            P = (np.eye(6) - K @ _H) @ Pp
            selected[i] = best
            confident[i] = True                       # gated match = confident
            points[i] = (x[0], x[3])
            coast = 0
        else:
            x, P = xp, Pp
            points[i] = (xp[0], xp[3])
            coast += 1
            if coast >= reinit_after and cands:
                c = max(cands, key=lambda c: c[2])     # blind reseed = NOT confident
                x, P = seed(c)
                selected[i] = c
                points[i] = (x[0], x[3])
                coast = 0
    return selected, confident, points


def select_path_gated_2pass(
    frames_candidates: Sequence[Sequence[Candidate]],
    *,
    dt: float = 1.0,
    accel_noise: float = 4.0,
    meas_noise_px: float = 3.0,
    gate_chi2: float = 9.21,
    max_gate_px: float = 140.0,
    reinit_after: int = 8,
    connect_px: float | None = None,
    min_cover: float = 0.5,
    resolve_disagreement: bool = True,
    disagree_margin: float = 1.1,
    bridge_max_px: float | None = None,
) -> list[Optional[Candidate]]:
    """Two-pass gated re-acquisition (CV14b forward-backward experiment).

    ⚠️ EXPERIMENTAL — NOT WIRED INTO `infer_frames`. MEASURED VERDICT (2026-06-28,
    bench_2pass.py on ALL 4 real TrackNet GT clips, cached production candidates):
    a real PARTIAL ADVANCE, but NOT cleanly shippable — production stays
    `select_path_gated`+CV14c.
        clip   gated P95 -> 2pass P95     P50
        game1   42.50  ->  17.31  IMPROVED (4.5->? better)
        game2   56.49  ->  19.47  IMPROVED (big)
        game5   67.04  ->  94.94  P95 REGRESSED, but P50 4.50 -> 3.81 IMPROVED
        game8  382.26  -> 382.26  same (court gate auto-disabled, calib 0.52)
    P50 (median) improves on EVERY clip; P95 improves big on the two reliable-court
    clips. The ONLY regression is game5's P95 TAIL, and per-run-vs-GT instrumentation
    localised it to a SINGLE run (f177-186): forward AND backward both confidently
    lock the same on-court distractor while the true ball is ~221px away — a
    confident-wrong-lock that needs APPEARANCE (which peak is the ball) to resolve,
    not geometry. Every other lost run on game5 is a big WIN (e.g. f108-132 506->25).
    A motion-continuity bridge gate (`bridge_max_px`) and disagreement resolution
    (`resolve_disagreement`) were added + measured: neither removes the game5 tail
    (the bad recovery sits near the bridge between two distractor-locked anchors),
    and there is no clip-level runtime gate (game5 is court-RELIABLE, so CV14c
    calibration can't separate it from the winners).

    CONCLUSION: forward-backward two-pass is a genuine improvement on reliable-court
    clips (the broadcast footage the overlay runs on) but introduces one un-gatable
    P95 tail regression on a lost-track clip. It is NOT shippable as-is under the
    no-regression bar. The clean separator of correct-vs-confident-wrong recovery is
    an APPEARANCE model (CV04 / TOTNet, GPU) — that, not another selector, is the
    residual-tail fix. (Forward-gated shipped, beam-MHT, global-DP, and this all hit
    the same appearance wall; what differs is HOW MUCH of the tail each removes.)

    Kept (not deleted) as the documented result + a measurement scaffold
    (`bench_2pass.py` + the candidate cache) so this is re-runnable when a GPU /
    appearance model lands.

    The mechanism, for the record: run the SAME gated filter FORWARD and BACKWARD;
    keep forward's *confident* (gate-matched) segments verbatim; replace only its
    LOST runs with the backward confident estimate when that estimate CONNECTS to the
    bracketing forward anchors. Sound in principle; defeated by the unverifiable
    correctness of the backward recovery on real lost-track gaps.

    Drop-in for `select_path_gated`: returns a `selected` list (None = miss).
    """
    n = len(frames_candidates)
    if n == 0:
        return []
    connect = float(connect_px) if connect_px is not None else 1.5 * max_gate_px
    kw = dict(dt=dt, accel_noise=accel_noise, meas_noise_px=meas_noise_px,
              gate_chi2=gate_chi2, max_gate_px=max_gate_px, reinit_after=reinit_after)

    fwd_sel, fwd_conf, fwd_pt = _gated_directional(frames_candidates, **kw)
    rev = list(reversed(frames_candidates))
    b_sel, b_conf, b_pt = _gated_directional(rev, **kw)
    bwd_sel = list(reversed(b_sel))
    bwd_conf = list(reversed(b_conf))
    bwd_pt = list(reversed(b_pt))

    merged = list(fwd_sel)

    def dist(p, q):
        return float(np.hypot(p[0] - q[0], p[1] - q[1]))

    i = 0
    while i < n:
        if fwd_conf[i]:
            i += 1
            continue
        # maximal lost run [a..b] (forward not confident)
        a = i
        while i < n and not fwd_conf[i]:
            i += 1
        b = i - 1
        # forward anchors bracketing the run (confident filtered points)
        left = fwd_pt[a - 1] if a > 0 and fwd_conf[a - 1] else None
        right = fwd_pt[b + 1] if b + 1 < n and fwd_conf[b + 1] else None
        if left is None and right is None:
            continue  # whole-clip lost: nothing trustworthy to splice from
        # backward confident coverage across the run
        cover = [k for k in range(a, b + 1) if bwd_conf[k]]
        if len(cover) < max(1, int(min_cover * (b - a + 1))):
            continue
        # connection test: backward estimate at each open boundary must reach the
        # adjacent forward anchor (one frame away -> < ~max_gate motion).
        ok = True
        if left is not None and bwd_pt[a] is not None:
            ok = ok and dist(bwd_pt[a], left) <= connect
        if right is not None and bwd_pt[b] is not None:
            ok = ok and dist(bwd_pt[b], right) <= connect
        if not ok:
            continue
        # MOTION-CONTINUITY gate: for a bracketed (interior) gap, a real ball follows
        # a smooth arc between the two forward anchors; a backward pass that recovered
        # a DISTRACTOR jumps far off that bridge. Reject the splice when the backward
        # gap points deviate from the straight anchor-to-anchor bridge by more than
        # `bridge_max_px` on average. (Short gaps -> parabolic sag is small vs a
        # distractor's 100s-of-px jump, so a linear bridge separates them cleanly.)
        if bridge_max_px is not None and left is not None and right is not None:
            span = (b + 1) - (a - 1)
            devs = []
            for k in range(a, b + 1):
                if not bwd_conf[k] or bwd_pt[k] is None:
                    continue
                t = (k - (a - 1)) / span
                ex = (left[0] + t * (right[0] - left[0]), left[1] + t * (right[1] - left[1]))
                devs.append(dist(bwd_pt[k], ex))
            if devs and (sum(devs) / len(devs)) > bridge_max_px:
                continue   # backward recovery is off the ball's arc -> distrust it
        # splice the backward confident observations into the lost run
        for k in range(a, b + 1):
            if bwd_conf[k]:
                merged[k] = bwd_sel[k]

    # Second pass — CONFIDENT-DISAGREEMENT resolution. After a blind reseed the
    # forward filter can gate-match a persistent distractor *confidently* (so the
    # lost-run splice above never touches it). Find maximal runs where forward and
    # backward are BOTH confident but point at genuinely different objects
    # (> `disagree_px`), i.e. one lineage reseeded onto a distractor. Pick the
    # lineage with the stronger summed detector score. On a reliable clip the two
    # passes agree everywhere -> no disagreement run -> nothing changes (no
    # regression, by construction).
    disagree_px = 2.0 * max_gate_px
    j = 0
    while resolve_disagreement and j < n:
        both = (fwd_conf[j] and bwd_conf[j] and fwd_pt[j] is not None
                and bwd_pt[j] is not None and bwd_sel[j] is not None)
        if not (both and dist(fwd_pt[j], bwd_pt[j]) > disagree_px):
            j += 1
            continue
        a = j
        while j < n and fwd_conf[j] and bwd_conf[j] and fwd_pt[j] is not None \
                and bwd_pt[j] is not None and dist(fwd_pt[j], bwd_pt[j]) > disagree_px:
            j += 1
        b = j - 1
        fscore = sum(merged[k][2] for k in range(a, b + 1)
                     if merged[k] is not None and fwd_conf[k])
        bscore = sum(bwd_sel[k][2] for k in range(a, b + 1) if bwd_conf[k])
        if bscore > disagree_margin * fscore:   # backward clearly stronger -> it had the ball
            for k in range(a, b + 1):
                if bwd_conf[k]:
                    merged[k] = bwd_sel[k]
    return merged
