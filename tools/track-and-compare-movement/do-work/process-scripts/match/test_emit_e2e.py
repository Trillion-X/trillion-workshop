#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_emit_e2e.py
#
# CV08 INTEGRATION test (plan §24.10): run the WHOLE assembled match-perception
# pipeline (court + WASB ball-state + bounce + line-call) on the REAL the reference player clip
# and regression-lock the emitted fact CONTRACT. Each leaf has a unit test; this
# asserts they compose correctly through emit_match_facts.py end-to-end.
#
# Environment-dependent — the models + clip live in the Society home (NOT this
# package, NOT court-ball-vision). Their location is DATA: MATCH_VENDOR_ROOT (the
# vendored model tree, exactly as emit_match_facts.py / wasb_infer.py resolve it)
# and MATCH_TEST_CLIP (defaulting to the clip homed under the vendor root). The
# generic package source carries ZERO model/clip paths (Physics/Society + MP2/MP10:
# the test runs from the Society home and has no court-ball-vision dependency). It
# SKIPS gracefully (exit 0) when the env DATA is absent — never a false failure.
#
# Run: MATCH_VENDOR_ROOT=<society>/court-ball-models python3 test_emit_e2e.py ; echo "EXIT $?"
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "_probe", "command-output-e2e.json")

VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not VENDOR:
    print("SKIP (env): MATCH_VENDOR_ROOT not set — the vendored model tree (Society home) is DATA")
    sys.exit(0)

CLIP = os.environ.get("MATCH_TEST_CLIP") or os.path.join(VENDOR, "_probe", "fed_court_720.mp4")
NEEDED = [CLIP,
          os.path.join(VENDOR, "weights", "court_detection.pt"),
          os.path.join(VENDOR, "pretrained_weights", "wasb_tennis_best.pth.tar")]

missing = [p for p in NEEDED if not os.path.exists(p)]
if missing:
    print(f"SKIP (env): missing {', '.join(os.path.basename(m) for m in missing)} under MATCH_VENDOR_ROOT — models/clip not present")
    sys.exit(0)

r = subprocess.run([sys.executable, os.path.join(HERE, "emit_match_facts.py"), CLIP, OUT, "e2e", "60"],
                   capture_output=True, text=True)
assert r.returncode == 0, f"emitter failed:\n{r.stderr[-2000:]}"
d = json.load(open(OUT))
facts = d["facts"]
by_kind = {}
for f in facts:
    by_kind.setdefault(f["kind"], []).append(f)

# --- court geometry: DENSE SERIES (WS3b-T4b) — one columnar fact, one entry per frame in parallel arrays ---
court_series = by_kind.get("perception.court.geometry.series", [])
assert len(court_series) == 1, f"expected exactly 1 court.geometry.series fact, got {len(court_series)}"
cs = court_series[0]
assert cs["count"] == 60, f"expected 60 court frames, got {cs['count']}"
assert len(cs["homography"]) == cs["count"] and len(cs["keypoints_present"]) == cs["count"], "court series arrays misaligned"
assert all(kp > 0 for kp in cs["keypoints_present"]), "court facts incomplete"

# --- ball.state: DENSE SERIES — provenance written ONCE in the header; per-frame status/confidence/cov as arrays ---
ball_series = by_kind.get("perception.ball.state.series", [])
assert len(ball_series) == 1, f"expected exactly 1 ball.state.series fact, got {len(ball_series)}"
bs = ball_series[0]
assert bs["count"] >= 55, f"ball.state not dense enough: {bs['count']}/60 (regression from 58)"
assert bs["provenance"]["model_name"] == "WASB-SBDT", "series provenance header wrong"
assert len(bs["status"]) == bs["count"] and len(bs["confidence"]) == bs["count"] and len(bs["covariance_2x2"]) == bs["count"], "ball series arrays misaligned"
for st in bs["status"]:
    assert st in ("observed", "interpolated", "occluded"), st
for cf in bs["confidence"]:
    assert 0.0 <= cf <= 1.0
# fail-closed: non-observed frames are strictly less confident than the observed mean
obs = [c for st, c in zip(bs["status"], bs["confidence"]) if st == "observed"]
non = [c for st, c in zip(bs["status"], bs["confidence"]) if st != "observed"]
if obs and non:
    assert (sum(non) / len(non)) < (sum(obs) / len(obs)), "non-observed must be lower-confidence (fail-closed)"

# --- bounce: physically plausible count, on-court gated, posterior >= 0.90 ---
bounce = by_kind.get("perception.ball.bounce", [])
assert len(bounce) <= 6, f"too many bounces for ~1s ({len(bounce)}) — physical min-gap regressed"
for f in bounce:
    assert f["event_confidence"] >= 0.90, f
    assert f["provenance"].get("court_plane_gated") is True, "bounce must be court-plane gated"

# --- line_call: EVERY call carries the full fail-closed contract, no hardcoded rectangles ---
calls = by_kind.get("perception.line_call", [])
for f in calls:
    assert f["call"] in ("IN", "OUT", "NEEDS_YOUR_CALL"), f["call"]
    for k in ("signed_distance_m", "sigma_m", "ball_radius_m", "decision_band_m", "call_confidence"):
        assert k in f, f"line_call missing fail-closed field {k}"
    assert f["provenance"], "line_call needs provenance"

# --- the OLD hardcoded classify() strings must be GONE (L030) ---
blob = json.dumps(facts)
for banned in ("IN_singles", "IN_doubles_alley"):
    assert banned not in blob, f"hardcoded classify() output {banned} still present — CV08 not applied"

print("CV08 E2E PASS — whole pipeline contract locked on the real clip")
print(f"  court {cs['count']}/60, ball.state {bs['count']}/60 (series header provenance+status+fail-closed),")
print(f"  bounces {len(bounce)} (court-plane gated, posterior>=0.90),")
print(f"  line_calls {len(calls)} all carry signed_distance/sigma/band/confidence/provenance,")
print(f"  zero hardcoded classify() rectangles.")
os.remove(OUT)
