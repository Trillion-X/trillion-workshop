# test_shot_speed.py — CJ-A.4 proof: the shot_speed leaf computes km/h from a court-metre
# ball track with fail-closed teleport gates, and is generic (injected envelope predicate).
from shot_speed import shot_speeds_kmh


def test_known_speed():
    # ball travels 10 m in 0.5 s (30 frames @ 60 fps, 1 m / 3 frames) -> 20 m/s -> 72 km/h.
    fps = 60.0
    track = [(i * 3, float(i), 0.0) for i in range(11)]  # frames 0,3,..30; x=0..10 m
    r = shot_speeds_kmh(track, fps)
    assert r["count"] == 10, r["count"]
    # each 3-frame hop = 1 m in 0.05 s = 20 m/s = 72 km/h
    assert abs(r["median"] - 72.0) < 0.1, r["median"]
    assert abs(r["peak"] - 72.0) < 0.1, r["peak"]
    print("PASS known_speed:", r["median"], "km/h")


def test_teleport_gate():
    # a TrackNet teleport (huge jump in 1 frame) must be discarded (> max_kmh), not reported.
    fps = 60.0
    track = [(0, 0.0, 0.0), (1, 50.0, 0.0)]  # 50 m in 1/60 s = 3000 m/s -> absurd
    r = shot_speeds_kmh(track, fps, max_kmh=400.0)
    assert r["count"] == 0, r  # gated out
    print("PASS teleport_gate: discarded", )


def test_gap_gate():
    # a long frame gap (occlusion) is not a real consecutive flight -> skipped.
    fps = 60.0
    track = [(0, 0.0, 0.0), (20, 1.0, 0.0)]  # df=20 > max_gap_frames(4)
    r = shot_speeds_kmh(track, fps, max_gap_frames=4)
    assert r["count"] == 0, r
    print("PASS gap_gate: skipped")


def test_injected_envelope_predicate():
    # the in-court envelope is INJECTED (generic leaf knows no court). A segment with an
    # out-of-envelope endpoint is dropped; ZERO court vocabulary in the leaf.
    fps = 60.0
    track = [(0, 1.0, 1.0), (3, 2.0, 1.0), (6, 99.0, 99.0)]  # 3rd point far outside
    in_box = lambda xy: 0 <= xy[0] <= 10 and 0 <= xy[1] <= 10
    r = shot_speeds_kmh(track, fps, accept=in_box)
    assert r["count"] == 1, r  # only the first hop (both endpoints in box) survives
    print("PASS injected_envelope:", r["samples"])


def test_empty_and_bad_fps():
    assert shot_speeds_kmh([], 60.0)["count"] == 0
    assert shot_speeds_kmh([(0, 0.0, 0.0), (3, 1.0, 0.0)], 0)["count"] == 0  # fps<=0 -> no crash
    print("PASS empty_and_bad_fps (fail-closed)")


def test_bounce_to_bounce_valid_measure():
    """The geometrically-VALID measure: average speed between GROUND contacts (both
    endpoints on the court plane -> homography exact, no off-plane inflation)."""
    from shot_speed import bounce_to_bounce_speeds_kmh
    # two bounces 5 m apart, 10 frames @ 50 fps = 0.2 s -> 25 m/s = 90 km/h
    r = bounce_to_bounce_speeds_kmh([(0, 0.0, 0.0), (10, 5.0, 0.0)], 50.0)
    assert r["count"] == 1 and abs(r["peak"] - 90.0) < 0.1, r
    # an off-court bounce is excluded by the injected envelope -> fail-closed
    on_court = lambda xy: 0 <= xy[0] <= 11 and 0 <= xy[1] <= 24
    off = [(0, 5.0, 5.0), (10, 5.0, 30.0)]   # 2nd bounce off the back of the court
    assert bounce_to_bounce_speeds_kmh(off, 50.0, accept=on_court)["count"] == 0
    print("PASS bounce_to_bounce valid measure (90 km/h known; off-court fail-closed)")


if __name__ == "__main__":
    test_known_speed()
    test_teleport_gate()
    test_gap_gate()
    test_injected_envelope_predicate()
    test_empty_and_bad_fps()
    test_bounce_to_bounce_valid_measure()
    print("ALL shot_speed tests PASS")
