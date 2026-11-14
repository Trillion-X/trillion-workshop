#!/usr/bin/env python3
"""Locks the L098 translation: motion-clip-descriptor.v1 -> motion-analysis track + phase records.

Pure, synthetic — no heavy env. The record-maker is the package's data-owner boundary; perception emits
its native descriptor and this maps it. Run: python3 test_descriptor_mapping.py"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "rm", HERE / "make-motion-analysis-records-from-command-output.py")
rm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rm)

fails = []


def ok(cond, msg):
    print(("PASS" if cond else "FAIL"), msg)
    if not cond:
        fails.append(msg)


REQUEST = {"request_id": "req-1", "sources": [{"source_index": 0, "source_fingerprint": "fp-x"}],
           "requested_at": "2026-06-27T00:00:00Z"}
DESC = {
    "schema": "motion-clip-descriptor.v1",
    "source": {"path": "/x/clip.mp4", "fingerprint": "abc123"},
    "fps": 30.0, "frames": 60,
    "salience_fp": "default",
    "windows": [
        {"t0": 0.1, "t1": 0.9, "state": {"knee_bend": 0.7}, "peak_t": 0.5, "viewpoint": {"vec": [1, 2], "confidence": 0.9},
         "heading": 180.0, "elevation": 12.0, "quality": 0.8, "full_swing": True},
        {"t0": 1.0, "t1": 1.8, "state": {"knee_bend": 0.6}, "peak_t": 1.4, "viewpoint": {"vec": [3, 4], "confidence": 0.7},
         "heading": 170.0, "elevation": 10.0, "quality": 0.75, "full_swing": False},
    ],
}

recs = rm.canonical_records_from_command(REQUEST, DESC)
kinds = {}
for r in recs:
    kinds[r["payload"]["kind"]] = kinds.get(r["payload"]["kind"], 0) + 1

ok(kinds == {"motion-analysis.track": 1, "motion-analysis.phase": 2}, f"1 track + 2 phases (got {kinds})")
ok(not any(r["payload"]["kind"] == "motion-analysis.error" for r in recs), "no error record on a valid descriptor")

track = next(r["payload"] for r in recs if r["payload"]["kind"] == "motion-analysis.track")
ok(track["time_range"] == {"start": 0.0, "end": 2.0}, f"track time_range = clip duration frames/fps (got {track['time_range']})")
ok(track["sample_rate"] == 30.0, "track sample_rate = fps")
ok(track["evidence"]["frames"] == 60 and track["evidence"]["window_count"] == 2, "track evidence carries frames+window_count")
ok(track["source_fingerprint"] == "abc123", "track source_fingerprint = descriptor.source.fingerprint")

phases = [r["payload"] for r in recs if r["payload"]["kind"] == "motion-analysis.phase"]
ok(phases[0]["label"] == "motion window 1" and phases[1]["label"] == "motion window 2",
   "phase labels are POSITIONAL (engine is label-free; no stroke vocabulary)")
ok(phases[0]["time_range"] == {"start": 0.1, "end": 0.9}, "phase time_range = window t0/t1")
# state is a measure DICT and must survive in evidence (NOT be the label)
ok(isinstance(phases[0]["evidence"].get("state"), dict) and phases[0]["evidence"]["state"]["knee_bend"] == 0.7,
   "window `state` measure dict carried through in evidence (not used as label)")
# every non-time window field is present in evidence (completeness — nothing dropped)
for k in ("peak_t", "viewpoint", "heading", "elevation", "quality", "full_swing"):
    ok(k in phases[0]["evidence"], f"window field '{k}' carried into phase evidence")
ok("t0" not in phases[0]["evidence"] and "t1" not in phases[0]["evidence"], "time bounds excluded from evidence (they are the time_range)")
# track_ref wires phase -> track
ok(phases[0]["track_ref"].get("track_id") == track["track_id"], "phase.track_ref wires to the track_id")
# full_swing False must survive as a real bool (not dropped/coerced)
ok(phases[1]["evidence"]["full_swing"] is False, "full_swing=False survives (no fail-open coercion)")

# --- dispatch: a descriptor with windows but no schema string still maps; garbage -> error -----------
recs2 = rm.canonical_records_from_command(REQUEST, {"windows": DESC["windows"], "fps": 30.0, "frames": 60, "source": {"fingerprint": "z"}})
ok(any(r["payload"]["kind"] == "motion-analysis.phase" for r in recs2), "dispatch on presence of windows[] (no schema string needed)")
recs3 = rm.canonical_records_from_command(REQUEST, {"unexpected": "shape"})
ok(len(recs3) == 1 and recs3[0]["payload"]["kind"] == "motion-analysis.error", "unknown shape -> single error record (fail-closed)")

print()
if fails:
    print(f"{len(fails)} FAILURE(S)")
    sys.exit(1)
print("ALL PASS")
