# rally_events.py — generic perception EVENT EXTRACTOR (CJ-A.3, first slice).
#
# Turns the geometry facts this lane already emits (bounces with court_xy_m + an
# optional in/out call, and the ball track in court metres) into a canonical,
# ORDERED, DISCRETE EVENT STREAM: bounce@side and net-crossing.
#
# It bakes in NO scoring rules. "Two bounces same side = point", "out = point to
# the other player", win-by-two, deuce — none of that lives here. Those are DATA
# in the DMG reduce-graph (progression-evaluator) that CONSUMES this stream
# (NO-GOD-PACKAGE: we reuse the existing scoring engine, we do not re-own it).
# This module is the translator from continuous geometry to the discrete alphabet
# that the reduce-graph runs on.
#
# Everything sport/court-specific is a DATA parameter (net axis + net position +
# side labels), so the SAME extractor serves tennis, pickleball, padel, or any
# net-divided court by passing different DATA — zero code change (L069/L090).
#
# Pure function, zero I/O. Validatable on SYNTHETIC event sequences (TrackNet has
# no point/score labels, so real-video rally accuracy is deferred to a labelled
# set; the MECHANISM is what this slice proves).

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence


@dataclass
class RallyEvent:
    """One observed geometry event — NOT a scoring verdict."""
    frame: int
    kind: str                      # "bounce" | "net_cross"
    side_sign: int                 # +1 / -1: which side of the net (sign of pos-net); 0 for net_cross
    court_xy_m: Optional[tuple]    # (x,y) metres for a bounce; None for net_cross
    in_bounds: Optional[bool]      # bounce only, from the line-call; None = unknown
    provenance: dict


def _coord(b, key, idx):
    if isinstance(b, dict):
        return b.get(key)
    return getattr(b, key, None)


def extract_rally_events(
    bounces: Sequence,
    ball_track_m: Sequence,
    *,
    net_pos_m: float,
    net_axis: int = 1,
    side_labels: Optional[dict] = None,
    provenance: Optional[dict] = None,
) -> list[RallyEvent]:
    """Build the ordered rally-event stream.

    bounces      : iterable of {frame, court_xy_m:(x,y), in_bounds?:bool} (dict or obj)
    ball_track_m : ordered iterable of (frame, x_m, y_m) — the ball in COURT metres
    net_pos_m    : net-line position along `net_axis` (DATA, from the court spec)
    net_axis     : 0 = x, 1 = y (DATA — which axis the net divides)
    side_labels  : optional {+1:'near', -1:'far'} mapping folded into provenance
                   (the stream stays sign-based so it's sport-agnostic)

    Returns events ordered by frame; at the same frame a net_cross sorts before a
    bounce (the ball crosses, then lands).
    """
    prov = {"stage": "rally-events.v1", "net_pos_m": net_pos_m, "net_axis": net_axis}
    if side_labels:
        prov["side_labels"] = side_labels
    if provenance:
        prov.update(provenance)

    events: list[RallyEvent] = []

    # --- bounce events: side = which half of the net the bounce landed on ---
    for b in bounces:
        fr = _coord(b, "frame", 0)
        xy = _coord(b, "court_xy_m", 1)
        ib = _coord(b, "in_bounds", 2)
        if fr is None or xy is None:
            continue
        s = xy[net_axis] - net_pos_m
        events.append(RallyEvent(int(fr), "bounce", 1 if s >= 0 else -1,
                                 (round(float(xy[0]), 3), round(float(xy[1]), 3)),
                                 ib, prov))

    # --- net-cross events: the ball path changes side along net_axis ---
    pts = sorted((p for p in ball_track_m if p is not None), key=lambda p: p[0])
    for (f0, x0, y0), (f1, x1, y1) in zip(pts, pts[1:]):
        a = (x0, y0)[net_axis] - net_pos_m
        bb = (x1, y1)[net_axis] - net_pos_m
        if a == 0:
            a = 1e-9
        if a * bb < 0:   # strict sign change -> the ball crossed the net between f0 and f1
            events.append(RallyEvent(int(f1), "net_cross", 0, None, None, prov))

    # frame order; net_cross before bounce at the same frame (cross, then land)
    events.sort(key=lambda e: (e.frame, 0 if e.kind == "net_cross" else 1))
    return events


def in_bounds_from_call(call) -> Optional[bool]:
    """Map a line-call decision to the rally extractor's in_bounds tri-state.
    'IN' -> True, 'OUT' -> False, anything else (NEEDS_YOUR_CALL / unknown / absent)
    -> None (fail-closed: an uncertain call never asserts in/out)."""
    if call is None:
        return None
    c = str(call).strip().upper()
    if c == "IN":
        return True
    if c == "OUT":
        return False
    return None


def build_rally_fact(bounce_facts, ball_track_m, *, net_pos_m, net_axis,
                     line_call_by_frame=None, side_labels=None) -> dict:
    """Assemble the self-describing `perception.rally.events` fact from REAL perception
    facts: the bounce facts (each carrying `court_xy_m`) + the per-frame ball track in
    court metres. Bakes in NO scoring rules — it emits the ordered bounce@side /
    net_cross symbol stream the DMG reduce-graph (DATA) consumes. The net line is DATA
    (court_geometry.net_line_m); in/out comes from the line-call, never guessed.

    bounce_facts        : iterable of {frame, court_xy_m:[x,y]} (the emitted bounce facts)
    ball_track_m        : ordered iterable of (frame, x_m, y_m) — the ball in court metres
    line_call_by_frame  : {frame: call_string} from the perception.line_call facts
    """
    track = list(ball_track_m)
    calls = line_call_by_frame or {}
    bounces = []
    for f in bounce_facts:
        xy = f.get("court_xy_m")
        if xy is None:
            continue
        fr = f.get("frame")
        bounces.append({"frame": fr, "court_xy_m": xy,
                        "in_bounds": in_bounds_from_call(calls.get(fr))})
    events = extract_rally_events(bounces, track, net_pos_m=net_pos_m, net_axis=net_axis,
                                  side_labels=side_labels,
                                  provenance={"over": ["perception.ball.bounce", "perception.ball.state"]})
    symbols = events_to_symbols(events)
    first = events[0].frame if events else (bounces[0]["frame"] if bounces else 0)
    return {
        "kind": "perception.rally.events",
        "frame": int(first) if first is not None else 0,
        "symbols": symbols,
        "events": [{"frame": e.frame, "event": e.kind, "side_sign": e.side_sign,
                    "court_xy_m": list(e.court_xy_m) if e.court_xy_m else None,
                    "in_bounds": e.in_bounds} for e in events],
        "net_pos_m": round(float(net_pos_m), 3), "net_axis": int(net_axis),
        "bounce_count": len(bounces), "ball_track_points": len(track),
        "provenance": {"stage": "rally-events.v1",
                       "over": ["perception.ball.bounce", "perception.ball.state"]},
    }


def events_to_symbols(events: Sequence[RallyEvent]) -> list[str]:
    """Project the event stream to the compact symbol alphabet the reduce-graph
    runs `on` (DATA-driven transitions). A bounce becomes e.g. 'bounce:+1:in' /
    'bounce:-1:out' / 'bounce:+1:?'; a net cross becomes 'net_cross'. The
    reduce-graph DATA decides what each symbol means for the score."""
    out = []
    for e in events:
        if e.kind == "net_cross":
            out.append("net_cross")
        else:
            ib = "in" if e.in_bounds is True else "out" if e.in_bounds is False else "?"
            out.append(f"bounce:{e.side_sign:+d}:{ib}")
    return out
