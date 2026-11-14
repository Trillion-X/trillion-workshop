#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_player_positions_e2e.py
#
# CV-PLAYER INTEGRATION test: run the live emitter with the player stage ENABLED
# (MATCH_EMIT_PLAYERS=1) on a bounded slice of the real clip and assert it produces
# real perception.player.position facts (court metres + near/far side) plus the ONE
# reduced perception.player.coverage fact (occupancy grid), through the VENDORED
# PersonDetector — the "where the players are / track everything" feature ported out
# of court-ball-vision the package way. The dense position facts stay log:False (in
# the artifact, not the log); the coverage fact is log:True (consumable).
#
# Environment-dependent — SKIPS cleanly (exit 0) when MATCH_VENDOR_ROOT or the
# vendored models/clip are absent (and tolerates an absent fasterrcnn weight cache),
# exactly like test_emit_e2e / test_render_overlay. Never a false failure offline.
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "_probe", "player-e2e.json")

VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not VENDOR:
    print("SKIP (env): MATCH_VENDOR_ROOT not set — the vendored model tree (Society home) is DATA")
    sys.exit(0)

CLIP = os.environ.get("MATCH_TEST_CLIP") or os.path.join(VENDOR, "_probe", "fed_court_720.mp4")
NEEDED = [CLIP, os.path.join(VENDOR, "weights", "court_detection.pt")]
missing = [p for p in NEEDED if not os.path.exists(p)]
if missing:
    print(f"SKIP (env): missing {', '.join(os.path.basename(m) for m in missing)} under MATCH_VENDOR_ROOT")
    sys.exit(0)

MAXF = os.environ.get("MATCH_TEST_MAX_FRAMES", "30")
env = {**os.environ, "MATCH_EMIT_PLAYERS": "1"}
r = subprocess.run([sys.executable, os.path.join(HERE, "emit_match_facts.py"), CLIP, OUT, "player-e2e", MAXF],
                   capture_output=True, text=True, env=env)

# fasterrcnn pulls COCO weights from the torch hub cache; if that cache is absent and
# the box is offline, the WEIGHT DOWNLOAD itself fails — skip rather than false-fail.
# The keywords are deliberately NARROW (genuine network-fetch signals only) so a real
# code bug FAILS loudly instead of being masked as "offline".
if r.returncode != 0:
    blob = (r.stderr + r.stdout).lower()
    if any(k in blob for k in ("urlopen", "max retries", "name resolution",
                               "temporary failure", "certificate", "connectionerror",
                               "failed to download")):
        print(f"SKIP (env): person-detector weights could not be downloaded offline:\n{r.stderr[-400:]}")
        sys.exit(0)
    raise AssertionError(f"emit_match_facts (players) failed:\n{r.stderr[-2000:]}")

assert os.path.exists(OUT), f"command-output not produced at {OUT}"
doc = json.load(open(OUT))
facts = doc["facts"]
# DENSE SERIES (WS3b-T4b): player positions are ONE columnar series fact (provenance once), not one dict
# per detection; per-detection values are parallel arrays indexed together.
series = [f for f in facts if f["kind"] == "perception.player.position.series"]
coverages = [f for f in facts if f["kind"] == "perception.player.coverage"]

assert len(coverages) == 1, f"expected exactly ONE coverage fact, got {len(coverages)}"
cov = coverages[0]
assert "near_court" in cov and "far_court" in cov and "grid" in cov, "coverage fact missing structure"

assert len(series) == 1, f"expected exactly 1 player.position.series fact, got {len(series)}"
ps = series[0]
# the real clip HAS players on court — the feature must actually detect+place them
# (guards against a hollow green where the gate silently rejects every detection).
assert ps["count"] > 0, ("0 player positions on a clip with players — the on-court "
                         "gate is rejecting real detections (player play-envelope too tight)")
assert (cov["near_court"] or cov["far_court"]), "coverage has neither near nor far side populated"

# the dense position series must be log:False (artifact only — not exploded to the log)
record_kinds = {r_["payload"]["kind"] for r_ in doc["records"]}
assert "perception.player.position.series" not in record_kinds, "dense player.position.series must be log:False"
# the reduced coverage fact MUST be a persisted record (log:True, consumable)
assert "perception.player.coverage" in record_kinds, "coverage fact must be log:True (a record)"

# every position is self-describing: court metres + a near/far side + confidence (parallel arrays, aligned)
assert len(ps["court_xy_m"]) == ps["count"] and len(ps["side"]) == ps["count"] and len(ps["confidence"]) == ps["count"], "player series arrays misaligned"
for xy, side, conf in zip(ps["court_xy_m"], ps["side"], ps["confidence"]):
    assert isinstance(xy, list) and len(xy) == 2
    assert side in ("near", "far")
    assert 0.0 <= float(conf) <= 1.0

print("CV-PLAYER E2E PASS — player positions + coverage emit through the live path")
print(f"  {ps['count']} player positions (series, log:False); 1 player.coverage fact (log:True)")
print(f"  near={bool(cov['near_court'])} far={bool(cov['far_court'])} grid={cov['grid']} extent_m={cov.get('extent_m')}")
os.remove(OUT)
