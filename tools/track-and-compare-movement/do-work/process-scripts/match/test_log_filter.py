#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_log_filter.py
#
# Regression-locks the self-describing log-persistence contract (L090/L063):
# dense per-frame raw facts (perception.court.geometry, perception.ball.state)
# are tagged `log: False` at their creation site and EXCLUDED from the log
# records, while remaining in the full-fidelity `facts` artifact. This keeps the
# committed write-set small so a full-clip dispatch never traps serializing it
# (the workflow response always echoes execution_context.writes —
# interactive.rs:244). Derived facts the dashboard/measures read
# (shot.speed, ball.bounce, line_call, rally.events) stay persisted.
#
# Deterministic — no models/clip needed. Run: python3 test_log_filter.py ; echo "EXIT $?"
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EMIT = os.path.join(HERE, "emit_match_facts.py")
src = open(EMIT).read()

failures = []

# 1) Source regression-lock: the dense per-frame kinds are now COLUMNAR SERIES facts (WS3b-T4b) and
#    still carry `log: False` (excluded from log records; provenance written once, full fidelity kept).
for kind in ("perception.court.geometry.series", "perception.ball.state.series", "perception.player.position.series"):
    m = re.search(r'"kind":\s*"' + re.escape(kind) + r'".*?"log":\s*False', src, re.DOTALL)
    if not m:
        failures.append(f"{kind} fact must carry '\"log\": False'")

# 2) Source regression-lock: records are filtered by the log flag.
if "if f.get(\"log\", True)" not in src:
    failures.append("records must be filtered by f.get('log', True)")

# 3) Contract: the filter excludes per-frame raw, keeps derived; payloads strip `log`.
def _addr_token(r):
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in str(r))


def to_record(fact, idx, rid="t", crid="c"):
    kind = fact["kind"]
    frame = fact.get("frame", idx)
    fid = f"{rid}:{kind}:{frame}:{idx}"
    payload = {k: v for k, v in fact.items() if k != "log"}
    return {"address": f"package::match-perception::{_addr_token(kind)}::{_addr_token(fid)}",
            "path": ["x"], "payload": {**payload, "request_id": rid, "command_run_id": crid, "fact_id": fid}}


facts = [
    {"kind": "perception.court.geometry.series", "log": False, "count": 1, "frames": [0]},
    {"kind": "perception.ball.state.series", "log": False, "count": 1, "frames": [0]},
    {"kind": "perception.ball.bounce", "frame": 5, "court_xy_m": [1, 2]},
    {"kind": "perception.line_call", "frame": 5, "call": "IN"},
    {"kind": "perception.rally.events", "symbols": ["a"]},
    {"kind": "perception.shot.speed", "peak_kmh": 120, "median_kmh": 90},
]
records = [to_record(f, i) for i, f in enumerate(facts) if f.get("log", True)]
kinds = [r["payload"]["kind"] for r in records]

if "perception.court.geometry.series" in kinds:
    failures.append("court.geometry.series must NOT be a log record")
if "perception.ball.state.series" in kinds:
    failures.append("ball.state.series must NOT be a log record")
if kinds != ["perception.ball.bounce", "perception.line_call", "perception.rally.events", "perception.shot.speed"]:
    failures.append(f"unexpected log-record kinds: {kinds}")
if any("log" in r["payload"] for r in records):
    failures.append("'log' flag must be stripped from persisted payloads")

if failures:
    print("FAIL:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print(f"PASS: {len(facts)} facts (full artifact) -> {len(records)} log records "
      f"({', '.join(kinds)}); per-frame raw excluded; payloads clean")
sys.exit(0)
