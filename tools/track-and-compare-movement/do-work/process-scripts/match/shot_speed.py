"""shot_speed.py — CJ-A.4 / MPV02: per-segment ball speed (km/h) over a court-metre
ball track. A pure measure leaf: it owns ONLY the speed math + the fail-closed
teleport gates. It knows NOTHING about tennis, the court, or how the track was
produced — the in-court envelope test is an INJECTED predicate (like bounce_detect's
`accept`), so a different court/sport supplies a different predicate, zero code change.

Speed = metric distance between consecutive sightings / Δt × 3.6. Gates (fail-closed
against TrackNet false-match teleports): near-consecutive only (Δframe ≤ max_gap_frames),
both endpoints accepted by the envelope predicate, and speed < max_kmh (above any real
tennis shot).

⚠️ GEOMETRIC LIMIT (measured 2026-06-28, observation 2026-06-28-shot-speed-off-plane-geometry):
`shot_speeds_kmh` reads the IN-FLIGHT ball, which is ABOVE the court plane. A single
ground homography back-projects the ball's image point to where a GROUND point would
be; for an elevated, moving ball that ground-intersection sweeps FASTER than the ball's
true horizontal motion, so frame-to-frame in-flight km/h is GEOMETRICALLY INFLATED — on
the real fed60 track median 119.6 / peak 371 km/h (a world-record serve is ~263). This
is NOT jitter (a windowed least-squares fit + residual gate was tried and did NOT remove
it — L108), it is the off-plane projection. NO 2D-track processing fixes it; a true
in-flight speed needs the ball's HEIGHT (a second view or a physics/trajectory model).
The geometrically VALID monocular measure is `bounce_to_bounce_speeds_kmh` below — both
endpoints are GROUND contacts, so the homography is exact. Treat `shot_speeds_kmh` output
as an UPPER-BOUND proxy only, never as a trustworthy headline.
"""
from __future__ import annotations
import math


def shot_speeds_kmh(track_m, fps, *, max_kmh=400.0, max_gap_frames=4, accept=None):
    """track_m: ordered iterable of (frame, x_m, y_m) — the ball in COURT metres.
    fps: frames per second (>0). accept: optional (x_m, y_m) -> bool court-envelope
    test (None = accept all). Returns
    {samples:[{frame,kmh}], count, median, p90, peak} (stats keys present only when
    count > 0). Pure; no I/O, no court/sport vocabulary."""
    pts = sorted((p for p in track_m if p is not None), key=lambda p: p[0])
    samples = []
    if fps and fps > 0:
        for (f0, x0, y0), (f1, x1, y1) in zip(pts, pts[1:]):
            df = f1 - f0
            if df <= 0 or df > max_gap_frames:
                continue
            if accept is not None and not (accept((x0, y0)) and accept((x1, y1))):
                continue
            metres = math.hypot(x1 - x0, y1 - y0)
            kmh = (metres / (df / fps)) * 3.6
            if kmh < max_kmh:
                samples.append({"frame": int(f0), "kmh": round(kmh, 1)})
    out = {"samples": samples, "count": len(samples)}
    if samples:
        vals = sorted(s["kmh"] for s in samples)
        out["median"] = round(_percentile(vals, 50), 1)
        out["p90"] = round(_percentile(vals, 90), 1)
        out["peak"] = round(vals[-1], 1)
    return out


def bounce_to_bounce_speeds_kmh(bounces_m, fps, *, max_kmh=400.0, accept=None):
    """The geometrically VALID monocular ball-speed measure: the average speed over
    each flight between two consecutive GROUND contacts (bounces). Both endpoints are
    ON the court plane, so the ground homography projects them exactly — no off-plane
    error (unlike the in-flight `shot_speeds_kmh`). It is a conservative AVERAGE (the
    ball arcs up and down between bounces), so it UNDER-reads peak racket speed, but it
    is honest and stable.

    bounces_m: ordered iterable of (frame, x_m, y_m) — bounce contacts in court metres.
    Returns {samples:[{frame,kmh}], count, median, p90, peak} (stats only when count>0).
    Pure; no court/sport vocabulary (the envelope `accept` is injected as before)."""
    pts = sorted((p for p in bounces_m if p is not None), key=lambda p: p[0])
    samples = []
    if fps and fps > 0:
        for (f0, x0, y0), (f1, x1, y1) in zip(pts, pts[1:]):
            df = f1 - f0
            if df <= 0:
                continue
            if accept is not None and not (accept((x0, y0)) and accept((x1, y1))):
                continue
            kmh = (math.hypot(x1 - x0, y1 - y0) / (df / fps)) * 3.6
            if kmh < max_kmh:
                samples.append({"frame": int(f0), "kmh": round(kmh, 1)})
    out = {"samples": samples, "count": len(samples)}
    if samples:
        vals = sorted(s["kmh"] for s in samples)
        out["median"] = round(_percentile(vals, 50), 1)
        out["p90"] = round(_percentile(vals, 90), 1)
        out["peak"] = round(vals[-1], 1)
    return out


def _percentile(sorted_vals, q):
    """Linear-interpolated percentile of an already-sorted list (no numpy dep)."""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = (q / 100.0) * (len(sorted_vals) - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)
