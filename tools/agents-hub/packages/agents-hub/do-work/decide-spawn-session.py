#!/usr/bin/env python3
# package-set://bitfield-studio/packages/agents-hub/do-work/decide-spawn-session.py
#
# Purpose:
#   The SINGLE-FLIGHT gate for clock-driven AI session cadence. Pure computation:
#   given the last-spawn marker payload and a minimum interval, decide whether a new
#   session may be spawned on THIS clock tick.
#
#   The hazard this solves: the clock ticks far faster (every ~30s) than one AI
#   decision cycle completes (~2-5 min). Firing a session every tick would pile up
#   dozens of overlapping AI sessions. This gate emits should_spawn=true ONLY when
#   at least MIN_INTERVAL_MS has elapsed since the last spawn — so exactly one
#   session is in flight per interval.
#
# Why python (not a binding op): only a process can read a real wall clock
#   (time.time()). Workflow binding transforms have no "now". The whole decision —
#   now vs last, elapsed, threshold — is therefore one deterministic python step
#   whose boolean the gating edges read.
#
# Contract:
#   argv: decide-spawn-session.py <last_spawn_marker_json> <min_interval_ms>
#     <last_spawn_marker_json> — the current `last-decision-spawn` record payload as
#        JSON, or "" / "null" / "{}" when the marker does not exist yet (first run).
#        Shape when present: {"ts_ms": <int>}. Absent/garbage ts -> treated as 0
#        (never spawned) -> should_spawn=true on the first tick.
#     <min_interval_ms> — minimum milliseconds between spawns (e.g. 300000 = 5 min).
#        Missing/invalid -> usage error (exit 2 == no-op; the cadence MUST be explicit).
#
#   EXIT CODE encodes the decision (this is the gate the workflow edges read):
#     0  -> SHOULD SPAWN (interval elapsed). The on_result edges
#           (`input.output.termination.code == 0`) fire write_marker + spawn.
#     3  -> NO-OP this tick. A nonzero termination code makes the edge condition
#           false -> write_marker + spawn are Skipped -> the action completes cleanly.
#     2  -> usage error (missing/invalid args). Also != 0 -> treated as no-op (fail-closed:
#           a broken gate never spawns).
#   WHY termination.code (not captured stdout bytes): a compute.process step's fd 1
#   capture is a byte side-channel; the workflow EDGE resolver reads the inline
#   ProcessResult termination object. The spawn/no-spawn decision therefore rides
#   `termination.code`. The marker write, which runs in the full step-binding context,
#   still decodes now_ms from captured fd 1.
#
#   captured fd 1 (JSON) — decoded by the marker-write step: {
#     "should_spawn": bool,        # mirrors the exit code (0 -> true)
#     "now_ms": int,               # wall clock now (ms) — the marker write records this
#     "last_ms": int,              # parsed last spawn ms (0 if never)
#     "elapsed_ms": int,           # now_ms - last_ms (>=0)
#     "min_interval_ms": int       # echoed threshold
#   }
#
# Non-Negotiable Invariants:
#   1. Deterministic given (now, last, interval). The ONLY nondeterminism is now_ms,
#      which is intentional — the cadence is time-driven.
#   2. Fail-closed on a bad threshold: an invalid/absent min_interval_ms exits 2 (no-op)
#      rather than spawning. A bad marker fails OPEN to "never spawned" (so a corrupt
#      marker can never wedge the cadence shut forever).
#   3. No domain vocabulary. This gate knows nothing about trading. It is the generic
#      "should I start a new session this tick?" primitive — any cadence can reuse it.

# Exit codes (the decision channel the edges read).
EXIT_SHOULD_SPAWN = 0
EXIT_NO_OP = 3
EXIT_USAGE = 2

import json
import sys
import time


def _parse_marker_ts_ms(raw: str) -> int:
    """Parse the last-spawn marker's ts_ms. Absent/garbage -> 0 (never spawned)."""
    if raw is None:
        return 0
    text = raw.strip()
    if text == "" or text.lower() == "null":
        return 0
    try:
        marker = json.loads(text)
    except (ValueError, TypeError):
        return 0
    if not isinstance(marker, dict):
        return 0
    ts = marker.get("ts_ms")
    if isinstance(ts, bool):  # bool is an int subclass — reject it explicitly
        return 0
    if isinstance(ts, (int, float)):
        return max(0, int(ts))
    return 0


def decide_spawn(last_marker_raw: str, min_interval_ms: int, now_ms: int) -> dict:
    """Pure single-flight decision. now_ms is injected so this is unit-testable."""
    last_ms = _parse_marker_ts_ms(last_marker_raw)
    elapsed_ms = max(0, now_ms - last_ms)
    should_spawn = elapsed_ms >= min_interval_ms
    return {
        "should_spawn": should_spawn,
        "now_ms": now_ms,
        "last_ms": last_ms,
        "elapsed_ms": elapsed_ms,
        "min_interval_ms": min_interval_ms,
    }


def main(argv: list) -> int:
    if len(argv) < 2:
        sys.stderr.write(
            "usage: decide-spawn-session.py <last_spawn_marker_json> <min_interval_ms>\n"
        )
        return EXIT_USAGE
    last_marker_raw = argv[0]
    try:
        min_interval_ms = int(str(argv[1]).strip())
    except (ValueError, TypeError):
        sys.stderr.write(
            f"min_interval_ms must be an integer, got {argv[1]!r}\n"
        )
        return EXIT_USAGE
    if min_interval_ms < 0:
        sys.stderr.write(
            f"min_interval_ms must be >= 0, got {min_interval_ms}\n"
        )
        return EXIT_USAGE

    now_ms = int(time.time() * 1000)
    result = decide_spawn(last_marker_raw, min_interval_ms, now_ms)
    # stdout carries now_ms (+ diagnostics) for the marker-write step.
    sys.stdout.write(json.dumps(result))
    # The exit code is the decision channel the gating edges read.
    return EXIT_SHOULD_SPAWN if result["should_spawn"] else EXIT_NO_OP


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
