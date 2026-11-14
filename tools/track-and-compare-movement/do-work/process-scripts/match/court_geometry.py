#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/court_geometry.py
#
# =============================================================================
# PURPOSE — CV07 (court→meters calibration) + CV06 (line-call) — plan §24.5.3
# =============================================================================
#
# Turn a ball BOUNCE (in court-reference coords, after the per-frame homography)
# into an IN / OUT / NEEDS_YOUR_CALL decision with a calibrated uncertainty band
# — never a fabricated call (fail-closed, plan §24.5.6).
#
# Two things this module is, and two things it is NOT:
#   IS: (1) the metric calibration from the yastrebksv court_reference space to
#          meters (CV07), and (2) a GENERIC point→polygon signed-distance line
#          call with ball-radius + uncertainty band (CV06).
#   NOT: it does NOT hardcode "tennis". The target area is a POLYGON passed as
#        DATA. Singles court, doubles court, a service box, a basketball key, a
#        cricket crease — all are polygons; the same `line_call` runs on any of
#        them with ZERO code change (L063/L090/enum-dissolution). The tennis
#        polygons below are DATA helpers, not the mechanism.
#
# Calibration (from TennisProject/court_reference.py): the reference image space
# is metric-consistent at ~0.01 m/unit. Exact per-axis scale:
#   scale_y = 23.77 m / (2935-561 units)   (baseline-to-baseline court length)
#   scale_x =  8.23 m / (1242-423 units)   (singles width)
# We convert every reference point to METERS first, then all distances are true
# meters and the in/out band is physical.
#
# The in/out rule (converged Claude+Codex, plan §24.5.3) on signed distance d
# (NEGATIVE = inside the target polygon, POSITIVE = outside), with band
# b = r_ball + k·σ + calibration_margin:
#   IN              iff  d <= -b
#   OUT             iff  d >= +b
#   NEEDS_YOUR_CALL otherwise   (the close calls — ask the human, never guess)
# σ is the bounce's positional std projected onto the nearest-boundary normal,
# from the propagated court-space covariance. Larger uncertainty widens the band
# → more NEEDS_YOUR_CALL → fail-closed.
#
# =============================================================================
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
# =============================================================================

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# --- CV07: calibration constants (DATA, from court_reference.py) ---
REF_BASELINE_TOP_Y = 561.0
REF_BASELINE_BOT_Y = 2935.0
REF_SINGLES_LEFT_X = 423.0
REF_SINGLES_RIGHT_X = 1242.0
REF_DOUBLES_LEFT_X = 286.0
REF_DOUBLES_RIGHT_X = 1379.0
REF_NET_Y = 1748.0
REF_SERVICE_TOP_Y = 1110.0
REF_SERVICE_BOT_Y = 2386.0
REF_MIDDLE_X = 832.0

COURT_LENGTH_M = 23.77      # ITF baseline-to-baseline
SINGLES_WIDTH_M = 8.23      # ITF singles width
SCALE_Y = COURT_LENGTH_M / (REF_BASELINE_BOT_Y - REF_BASELINE_TOP_Y)   # m / ref-unit
SCALE_X = SINGLES_WIDTH_M / (REF_SINGLES_RIGHT_X - REF_SINGLES_LEFT_X)  # m / ref-unit

BALL_RADIUS_M = 0.0335      # ITF tennis ball radius (~67mm diameter)


def ref_to_m(p) -> np.ndarray:
    """Court-reference (x,y) → meters (x,y)."""
    return np.array([p[0] * SCALE_X, p[1] * SCALE_Y], float)


REF_NET_AXIS = 1  # the net divides the court along Y (length) in the reference frame


def net_line_m() -> tuple[float, int]:
    """The net line as (position_along_axis_in_m, axis), in the SAME meter frame that
    `ref_to_m` (and therefore `homography_to_court_m` / `tennis_polygons`) produce.
    Pure DATA from the court reference spec — callers never hardcode the net position.
    A different court (or sport) overrides the REF_* spec, not this accessor."""
    return float(REF_NET_Y * SCALE_Y), REF_NET_AXIS


# --- tennis target polygons as DATA (helpers — NOT the mechanism) ---
def _rect_m(x0, x1, y0, y1) -> list[np.ndarray]:
    return [ref_to_m((x0, y0)), ref_to_m((x1, y0)), ref_to_m((x1, y1)), ref_to_m((x0, y1))]


def tennis_polygons() -> dict[str, list[np.ndarray]]:
    """Named tennis target polygons in METERS. Pure DATA; callers pick by
    `match.rule_context`. Add a sport = add a dict, not code."""
    return {
        "singles": _rect_m(REF_SINGLES_LEFT_X, REF_SINGLES_RIGHT_X, REF_BASELINE_TOP_Y, REF_BASELINE_BOT_Y),
        "doubles": _rect_m(REF_DOUBLES_LEFT_X, REF_DOUBLES_RIGHT_X, REF_BASELINE_TOP_Y, REF_BASELINE_BOT_Y),
        "serve_deuce_far": _rect_m(REF_MIDDLE_X, REF_SINGLES_RIGHT_X, REF_SERVICE_TOP_Y, REF_NET_Y),
        "serve_ad_far": _rect_m(REF_SINGLES_LEFT_X, REF_MIDDLE_X, REF_SERVICE_TOP_Y, REF_NET_Y),
        "serve_deuce_near": _rect_m(REF_SINGLES_LEFT_X, REF_MIDDLE_X, REF_NET_Y, REF_SERVICE_BOT_Y),
        "serve_ad_near": _rect_m(REF_MIDDLE_X, REF_SINGLES_RIGHT_X, REF_NET_Y, REF_SERVICE_BOT_Y),
    }


# --- CV06: generic geometry (polygon is DATA — no sport vocabulary) ---
def _seg_distance(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    ab = b - a
    t = 0.0 if np.dot(ab, ab) == 0 else float(np.clip(np.dot(p - a, ab) / np.dot(ab, ab), 0, 1))
    return float(np.hypot(*(p - (a + t * ab))))


def _point_in_polygon(p: np.ndarray, poly: list[np.ndarray]) -> bool:
    # ray casting
    x, y = p
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def signed_distance_to_polygon(p: np.ndarray, poly: list[np.ndarray]) -> float:
    """Distance from point to the polygon boundary; NEGATIVE inside, POSITIVE
    outside. Generic — any polygon, any sport (the polygon is DATA)."""
    d = min(_seg_distance(p, poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly)))
    return -d if _point_in_polygon(p, poly) else d


def _boundary_normal(p: np.ndarray, poly: list[np.ndarray]) -> np.ndarray:
    """Unit direction from the nearest boundary point to p (for projecting σ)."""
    best_d, best_q = float("inf"), p
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        ab = b - a
        t = 0.0 if np.dot(ab, ab) == 0 else float(np.clip(np.dot(p - a, ab) / np.dot(ab, ab), 0, 1))
        q = a + t * ab
        d = float(np.hypot(*(p - q)))
        if d < best_d:
            best_d, best_q = d, q
    v = p - best_q
    nv = float(np.hypot(*v))
    return v / nv if nv > 1e-9 else np.array([1.0, 0.0])


@dataclass
class LineCall:
    call: str                  # IN | OUT | NEEDS_YOUR_CALL
    target_polygon: str
    signed_distance_m: float
    sigma_m: float
    ball_radius_m: float
    decision_band_m: float
    call_confidence: float
    provenance: dict


def line_call(
    bounce_court_xy_m: np.ndarray,
    cov_court_m2: np.ndarray,
    polygon_m: list[np.ndarray],
    *,
    polygon_name: str = "polygon",
    ball_radius_m: float = BALL_RADIUS_M,
    calibration_margin_m: float = 0.01,
    sigma_mult: float = 1.96,
    provenance: dict | None = None,
) -> LineCall:
    """The fail-closed in/out call. `bounce_court_xy_m` and `polygon_m` are in
    METERS; `cov_court_m2` is the 2×2 positional covariance in m² (propagated
    from the ball-state covariance through the homography by the caller). Below
    the band, returns NEEDS_YOUR_CALL — never a fabricated call."""
    d = signed_distance_to_polygon(bounce_court_xy_m, polygon_m)
    nrm = _boundary_normal(bounce_court_xy_m, polygon_m)
    var_n = float(nrm @ np.asarray(cov_court_m2, float) @ nrm)
    sigma = float(np.sqrt(max(var_n, 0.0)))
    band = ball_radius_m + sigma_mult * sigma + calibration_margin_m
    if d <= -band:
        call = "IN"
    elif d >= band:
        call = "OUT"
    else:
        call = "NEEDS_YOUR_CALL"
    # confidence: how far past the band the call is, squashed to [0,1].
    margin_past = max(0.0, abs(d) - band)
    conf = float(np.clip(margin_past / (margin_past + max(sigma, 1e-3)), 0.0, 1.0))
    if call == "NEEDS_YOUR_CALL":
        conf = 0.0
    prov = {"stage": "line-call.geometry.v1", "scale_x_m_per_unit": SCALE_X,
            "scale_y_m_per_unit": SCALE_Y, **(provenance or {})}
    return LineCall(call, polygon_name, round(d, 4), round(sigma, 4), ball_radius_m,
                    round(band, 4), round(conf, 4), prov)


# --- CV14c: court-region candidate gate + homography self-calibration ---
# A pure geometry seam reused by BOTH the live emitter (CV08, which already has
# the per-frame homographies) and the offline validator. No court DETECTOR here
# (that lives in TennisProject) — only the projection + polygon test + the
# reliability calibration. cv2-free: the homography is applied with numpy.

def project_px_to_court_m(px, H) -> np.ndarray:
    """Image pixel (x,y) -> court METERS via homography H (image->court-reference),
    then ref_to_m. Pure numpy equivalent of cv2.perspectiveTransform + ref_to_m."""
    H = np.asarray(H, float)
    v = H @ np.array([float(px[0]), float(px[1]), 1.0])
    ref = (v[0] / v[2], v[1] / v[2])
    return ref_to_m(ref)


def court_region_accept(H_mats, *, margin_m: float = 4.0, polygon_name: str = "doubles"):
    """Build an `accept(frame, (x,y)) -> bool` candidate gate: keep a peak only if
    it projects within the target polygon + `margin_m` (alleys/just-out). Frames
    with no homography fail-OPEN (don't gate). The tracker stays court-agnostic;
    this predicate is injected (L090)."""
    poly = tennis_polygons()[polygon_name]

    def accept(frame, xy) -> bool:
        H = H_mats[frame] if frame < len(H_mats) and H_mats[frame] is not None else None
        if H is None:
            return True
        return signed_distance_to_polygon(project_px_to_court_m(xy, H), poly) < margin_m

    return accept


def calibrate_court_gate(cands, accept, *, min_strong: int = 10, min_frac: float = 0.70,
                         score_thresh: float = 0.70):
    """Decide whether the court fit is RELIABLE enough to hard-gate: the fraction
    of the clip's CONFIDENT (>= `score_thresh`) top detections that project on-court
    must be >= `min_frac` over >= `min_strong` samples. A wrong homography makes the
    true ball project off-court, fails this, and the caller keeps the ungated track
    (no regression). Returns (reliable: bool, fraction: float)."""
    strong = [(i, max(cs, key=lambda c: c[2])) for i, cs in enumerate(cands) if cs]
    strong = [(i, c) for i, c in strong if c[2] >= score_thresh]
    if len(strong) < min_strong:
        return False, 0.0
    on = sum(1 for i, c in strong if accept(i, (c[0], c[1])))
    frac = on / len(strong)
    return frac >= min_frac, frac
