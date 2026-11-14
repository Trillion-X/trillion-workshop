#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_court_geometry.py
#
# CV06/CV07 acceptance (plan §24.10):
#   - calibration: court reference → meters is metric-correct (singles 8.23m,
#     court length 23.77m, service box dimensions sane)
#   - a clearly-inside bounce -> IN; a clearly-outside bounce -> OUT
#   - an on-the-line bounce -> NEEDS_YOUR_CALL (never a fabricated call)
#   - HIGH uncertainty widens the band -> a would-be IN becomes NEEDS_YOUR_CALL
#     (fail-closed under uncertainty)
#   - GENERIC: a non-tennis polygon (a triangle) uses the SAME line_call, zero
#     code change (enum-dissolution proof)
#
# Run: python3 test_court_geometry.py

import numpy as np

from court_geometry import (
    SCALE_X, SCALE_Y, BALL_RADIUS_M, ref_to_m, tennis_polygons,
    signed_distance_to_polygon, line_call,
    court_region_accept, calibrate_court_gate, project_px_to_court_m,
)

TIGHT = np.diag([1e-6, 1e-6])  # ~1mm std: a confident bounce


def test_cv14c_court_region_gate_and_calibration():
    """CV14c (pure, no model): the court-region candidate gate + homography
    self-calibration. With H = identity, image px == court-reference coords, so the
    polygon test is exact and deterministic."""
    H = np.eye(3)
    accept = court_region_accept([H], margin_m=4.0)
    # a point in the middle of the doubles court -> accepted
    assert accept(0, (832.0, 1748.0)) is True
    # a point far beyond the right doubles sideline (~26m off) -> rejected
    assert accept(0, (4000.0, 1748.0)) is False
    # no homography this frame -> fail-open (never delete a candidate without a court)
    assert court_region_accept([None])(0, (4000.0, 1748.0)) is True

    on, off = (832.0, 1748.0, 0.9), (4000.0, 1748.0, 0.9)
    accept20 = court_region_accept([H] * 20, margin_m=4.0)   # one homography per frame
    # confident detections mostly on-court -> homography trusted (hard gate)
    rel, frac = calibrate_court_gate([[on]] * 20, accept20)
    assert rel is True and frac == 1.0, (rel, frac)
    # confident detections mostly off-court (wrong court fit) -> gate auto-disabled
    rel2, frac2 = calibrate_court_gate([[off]] * 20, accept20)
    assert rel2 is False and frac2 == 0.0, (rel2, frac2)
    # weak detections (< score_thresh) are ignored -> too few strong -> unreliable
    rel3, _ = calibrate_court_gate([[(832.0, 1748.0, 0.3)]] * 20, accept20)
    assert rel3 is False
    # projection sanity: identity H maps ref->meters via ref_to_m
    m = project_px_to_court_m((832.0, 1748.0), H)
    assert np.allclose(m, ref_to_m((832.0, 1748.0)))
    print("CV14c PASS — court-region gate + homography self-calibration (pure geometry)")


def main():
    polys = tennis_polygons()
    singles = polys["singles"]

    # --- CV07 calibration sanity ---
    width_m = abs(ref_to_m((1242, 561))[0] - ref_to_m((423, 561))[0])
    length_m = abs(ref_to_m((423, 2935))[1] - ref_to_m((423, 561))[1])
    assert abs(width_m - 8.23) < 0.05, f"singles width {width_m:.3f}m != 8.23"
    assert abs(length_m - 23.77) < 0.05, f"court length {length_m:.3f}m != 23.77"
    # service box length (net->service line) should be 6.40m
    sb = abs(ref_to_m((423, 1748))[1] - ref_to_m((423, 1110))[1])
    assert abs(sb - 6.40) < 0.20, f"service box length {sb:.3f}m != ~6.40"

    # --- clearly IN: center of the singles court ---
    center = (np.array(singles[0]) + np.array(singles[2])) / 2.0
    c = line_call(center, TIGHT, singles, polygon_name="singles")
    assert c.call == "IN", c
    assert c.signed_distance_m < 0, c

    # --- clearly OUT: 1m beyond the baseline ---
    out_pt = ref_to_m((832, 2935)) + np.array([0.0, 1.0])
    c = line_call(out_pt, TIGHT, singles, polygon_name="singles")
    assert c.call == "OUT", c
    assert c.signed_distance_m > 0, c

    # --- on the line: a bounce whose center sits right on the baseline ---
    on_line = ref_to_m((832, 2935))  # exactly on baseline
    c = line_call(on_line, TIGHT, singles, polygon_name="singles")
    assert c.call == "NEEDS_YOUR_CALL", f"on-line should be NEEDS_YOUR_CALL, got {c}"
    assert c.call_confidence == 0.0, c

    # --- a bounce ~5cm inside the line: tight cov -> still NEEDS_YOUR_CALL
    #     because band = r_ball(3.35cm)+margin(1cm) ~= 4.35cm > 5cm? actually
    #     5cm inside d=-0.05, band~0.0435 -> d<=-band -> IN. Verify the boundary
    #     behaves monotonically: 2cm inside must be NEEDS_YOUR_CALL.
    near_in_2cm = ref_to_m((832, 2935)) - np.array([0.0, 0.02])
    c2 = line_call(near_in_2cm, TIGHT, singles, polygon_name="singles")
    assert c2.call == "NEEDS_YOUR_CALL", f"2cm-inside should be ambiguous, got {c2}"

    # --- fail-closed under uncertainty: a clearly-inside-by-15cm point with a
    #     LARGE covariance (20cm std) widens the band past 15cm -> NEEDS_YOUR_CALL
    near_in_15cm = ref_to_m((832, 2935)) - np.array([0.0, 0.15])
    confident = line_call(near_in_15cm, TIGHT, singles)
    assert confident.call == "IN", confident
    uncertain = line_call(near_in_15cm, np.diag([0.04, 0.04]), singles)  # 20cm std
    assert uncertain.call == "NEEDS_YOUR_CALL", f"high cov must fail closed, got {uncertain}"
    assert uncertain.decision_band_m > confident.decision_band_m, "uncertainty must widen band"

    # --- GENERIC: a non-tennis polygon (triangle in meters) uses the SAME call ---
    triangle = [np.array([0.0, 0.0]), np.array([4.0, 0.0]), np.array([2.0, 3.0])]
    inside_tri = line_call(np.array([2.0, 1.0]), TIGHT, triangle, polygon_name="triangle")
    outside_tri = line_call(np.array([2.0, 5.0]), TIGHT, triangle, polygon_name="triangle")
    assert inside_tri.call == "IN" and outside_tri.call == "OUT", (inside_tri, outside_tri)

    # signed distance generic sanity
    assert signed_distance_to_polygon(np.array([2.0, 1.0]), triangle) < 0
    assert signed_distance_to_polygon(np.array([2.0, 5.0]), triangle) > 0

    print("CV06/CV07 PASS — calibrated, fail-closed, generic line-call")
    print(f"  calibration: singles {width_m:.3f}m, length {length_m:.3f}m, service {sb:.3f}m")
    print(f"  ball radius band base: {BALL_RADIUS_M*100:.1f}cm + 1.96σ + 1cm margin")
    print(f"  clear IN / clear OUT / on-line=NEEDS_YOUR_CALL ✓")
    print(f"  high covariance (20cm) flips IN→NEEDS_YOUR_CALL (fail-closed) ✓")
    print(f"  same line_call runs on a non-tennis triangle (enum-dissolution) ✓")


if __name__ == "__main__":
    main()
    test_cv14c_court_region_gate_and_calibration()
