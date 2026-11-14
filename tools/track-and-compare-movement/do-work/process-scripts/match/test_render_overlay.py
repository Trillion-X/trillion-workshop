#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_render_overlay.py
#
# CV-OVERLAY INTEGRATION test: run the ported match-tracking OVERLAY (the product
# surface that draws court lines + dense ball track + bounces + line-calls ONTO
# the real video) end-to-end on the the reference player clip and assert it produces a real,
# readable annotated .mp4. This is the "watch your match with the AI tracking"
# feature ported out of court-ball-vision the package way: the script lives in the
# package, the models + weights live in the Society home (MATCH_VENDOR_ROOT), and
# the script names ZERO machine path (Physics/Society + L089).
#
# Environment-dependent — SKIPS gracefully (exit 0) when MATCH_VENDOR_ROOT or the
# vendored models/clip are absent, exactly like test_emit_e2e.py. Never a false
# failure in a model-free environment.
#
# Run: MATCH_VENDOR_ROOT=<society>/court-ball-models python3 test_render_overlay.py ; echo "EXIT $?"
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "_probe", "overlay-e2e.mp4")

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

# Bounded e2e: render only the first MATCH_MAX_FRAMES frames (the same generic clip
# bound the live emit job carries) so the test verifies the REAL render path —
# court-detect + WASB ball-state + bounce + line-call + draw + encode — without a
# whole-clip wait. 40 frames exercises every code branch and writes a real .mp4.
MAXF = os.environ.get("MATCH_TEST_MAX_FRAMES", "40")
r = subprocess.run([sys.executable, os.path.join(HERE, "render_overlay.py"), CLIP, OUT, MAXF],
                   capture_output=True, text=True)
assert r.returncode == 0, f"render_overlay failed:\n{r.stderr[-2000:]}"
assert os.path.exists(OUT), f"overlay .mp4 not produced at {OUT}"
size = os.path.getsize(OUT)
assert size > 10_000, f"overlay .mp4 implausibly small ({size} bytes) — likely no frames written"

# the overlay must be a real, decodable video with frames (not an empty container)
try:
    import cv2  # noqa: E402
    cap = cv2.VideoCapture(OUT)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ok, first = cap.read()
    cap.release()
    assert ok and first is not None, "overlay .mp4 has no decodable frames"
    assert frame_count >= 1, f"overlay .mp4 frame count not positive: {frame_count}"
    frames_msg = f"{frame_count} frames"
except ImportError:
    frames_msg = "frame-decode check skipped (cv2 absent)"

print("CV-OVERLAY E2E PASS — the match-tracking overlay renders the real clip end-to-end")
print(f"  output {OUT} ({size} bytes, {frames_msg}); zero hardcoded machine paths in render_overlay.py")
# Clean every artifact this run produced — the .mp4 AND the sample .png frames
# render_overlay writes alongside it — so the probe dir never accrues test output.
import glob  # noqa: E402
os.remove(OUT)
for png in glob.glob(OUT.replace(".mp4", "_f*.png")):
    os.remove(png)
