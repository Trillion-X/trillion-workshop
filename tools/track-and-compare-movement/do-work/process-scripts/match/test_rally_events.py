# test_rally_events.py — CJ-A.3 first-slice proof (mechanism, on synthetic events).
#
# TrackNet labels ball position, NOT point/score boundaries, so rally accuracy on
# real video is deferred to a labelled set. This proves the EXTRACTOR mechanism:
# given a constructed rally's geometry, it emits the correct ordered event/symbol
# stream (bounce@side + in/out + net-crossings) that the DMG reduce-graph consumes.

from rally_events import (extract_rally_events, events_to_symbols,
                          build_rally_fact, in_bounds_from_call)

NET = 11.885   # net at mid-court (court length 23.77 m); DATA param, not hardcoded in the engine
# sides: y < NET -> "far" (sign -1), y > NET -> "near" (sign +1)


def test_rally_stream():
    # A rally: far serve -> bounces near IN -> returned -> bounces far IN ->
    # returned -> bounces near IN -> NOT returned -> bounces near again (DOUBLE
    # BOUNCE, no net cross between) == point ends. One bounce is OUT to exercise in/out.
    ball_track_m = [
        (0, 2.0, 5.0), (5, 2.0, 11.0),         # far, approaching net
        (10, 2.0, 14.0),                       # near  -> net_cross between 5 and 10
        (15, 3.0, 9.0),                        # far   -> net_cross between 10 and 15
        (20, 4.0, 14.0),                       # near  -> net_cross between 15 and 20
        (24, 4.0, 15.0), (26, 4.0, 15.5),      # stays near (NO cross) -> double bounce
    ]
    bounces = [
        {"frame": 12, "court_xy_m": (2.0, 14.0), "in_bounds": True},   # near, in
        {"frame": 17, "court_xy_m": (3.0, 9.0),  "in_bounds": True},   # far, in
        {"frame": 22, "court_xy_m": (4.0, 14.0), "in_bounds": True},   # near, in
        {"frame": 26, "court_xy_m": (4.0, 15.5), "in_bounds": True},   # near AGAIN (double bounce)
    ]
    ev = extract_rally_events(bounces, ball_track_m, net_pos_m=NET, net_axis=1,
                              side_labels={1: "near", -1: "far"})
    syms = events_to_symbols(ev)

    expected = [
        "net_cross",            # f10
        "bounce:+1:in",         # f12 near
        "net_cross",            # f15
        "bounce:-1:in",         # f17 far
        "net_cross",            # f20
        "bounce:+1:in",         # f22 near
        "bounce:+1:in",         # f26 near AGAIN (no net_cross since f22) -> rally-end signal
    ]
    assert syms == expected, syms

    # the rally-end signature the reduce-graph fires on: two consecutive same-side
    # bounces with NO net_cross between them (the receiver failed to return).
    last_two = [s for s in syms if s != "net_cross"][-2:]
    between = syms[syms.index("bounce:+1:in", 5):]   # from the f22 near-bounce onward
    assert last_two == ["bounce:+1:in", "bounce:+1:in"], last_two
    assert "net_cross" not in between, between
    print("PASS rally stream:", syms)


def test_out_bounce_and_side_signs():
    # an OUT bounce on the far side + a near bounce; no track -> no net_cross.
    bounces = [
        {"frame": 3, "court_xy_m": (1.0, 6.0), "in_bounds": False},    # far, OUT
        {"frame": 8, "court_xy_m": (5.0, 18.0), "in_bounds": True},    # near, in
        {"frame": 9, "court_xy_m": (5.0, 18.0)},                       # near, unknown in/out
    ]
    ev = extract_rally_events(bounces, [], net_pos_m=NET, net_axis=1)
    syms = events_to_symbols(ev)
    assert syms == ["bounce:-1:out", "bounce:+1:in", "bounce:+1:?"], syms
    # side signs: far below net -> -1, near above net -> +1
    assert [e.side_sign for e in ev] == [-1, 1, 1], ev
    print("PASS out/in + side signs:", syms)


def test_genericity_other_court():
    # DELETION TEST (L069): a totally different court — net on the X axis at x=10,
    # half the size. ZERO code change, the same extractor works from DATA alone.
    bounces = [{"frame": 1, "court_xy_m": (4.0, 2.0)},     # x<10 -> sign -1
               {"frame": 4, "court_xy_m": (16.0, 3.0)}]    # x>10 -> sign +1
    track = [(0, 4.0, 2.0), (3, 16.0, 3.0)]                # crosses x=10
    ev = extract_rally_events(bounces, track, net_pos_m=10.0, net_axis=0)
    syms = events_to_symbols(ev)
    assert syms == ["bounce:-1:?", "net_cross", "bounce:+1:?"], syms
    print("PASS genericity (net on X axis, different court):", syms)


def test_in_bounds_from_call():
    # the emit line-call literals are IN / OUT / NEEDS_YOUR_CALL. Map to the tri-state;
    # an uncertain or absent call NEVER asserts in/out (fail-closed).
    assert in_bounds_from_call("IN") is True
    assert in_bounds_from_call("OUT") is False
    assert in_bounds_from_call("NEEDS_YOUR_CALL") is None
    assert in_bounds_from_call(None) is None
    assert in_bounds_from_call("in") is True          # case-insensitive
    print("PASS in_bounds_from_call")


def test_net_line_from_court_spec():
    # The net line is DATA derived from the court reference spec — NOT a literal in emit.
    # ITF: net at mid-court; in the ref_to_m meter frame that homography_to_court_m
    # produces, that is REF_NET_Y * SCALE_Y ≈ 17.50 m along the Y (length) axis.
    from court_geometry import net_line_m
    pos, axis = net_line_m()
    assert axis == 1, axis
    assert abs(pos - 17.502) < 0.05, pos
    print(f"PASS net_line_from_court_spec: net at {pos:.3f} m, axis {axis}")


def test_build_rally_fact_on_real_court_frame():
    # The emit-side builder, exercised in the SAME meter frame emit uses (real net line
    # from the court spec), with a ball track that crosses the net + two real-shaped
    # bounce facts + real line-call literals. Proves the integration (project → build →
    # symbols) works on the real court geometry, not the test's stand-in NET above.
    from court_geometry import net_line_m
    net_pos_m, net_axis = net_line_m()              # ≈ (17.502, 1)
    # ball track: far (y<net) → approaches → near (y>net): one net-cross between f5,f10
    ball_track_m = [(0, 4.0, 8.0), (5, 4.0, 17.0), (10, 4.0, 20.0)]
    bounce_facts = [
        {"kind": "perception.ball.bounce", "frame": 12, "court_xy_m": [4.0, 20.0]},  # near (+1)
        {"kind": "perception.ball.bounce", "frame": 18, "court_xy_m": [3.0, 12.0]},  # far  (-1)
    ]
    line_call_by_frame = {12: "IN", 18: "OUT"}
    fact = build_rally_fact(bounce_facts, ball_track_m, net_pos_m=net_pos_m,
                            net_axis=net_axis, line_call_by_frame=line_call_by_frame)
    assert fact["kind"] == "perception.rally.events", fact["kind"]
    assert abs(fact["net_pos_m"] - 17.502) < 0.05, fact["net_pos_m"]
    assert fact["net_axis"] == 1
    assert fact["bounce_count"] == 2 and fact["ball_track_points"] == 3
    assert fact["symbols"] == ["net_cross", "bounce:+1:in", "bounce:-1:out"], fact["symbols"]
    print("PASS build_rally_fact on real court frame:", fact["symbols"])


if __name__ == "__main__":
    test_rally_stream()
    test_out_bounce_and_side_signs()
    test_genericity_other_court()
    test_in_bounds_from_call()
    test_net_line_from_court_spec()
    test_build_rally_fact_on_real_court_frame()
    print("ALL rally-events tests PASS")
