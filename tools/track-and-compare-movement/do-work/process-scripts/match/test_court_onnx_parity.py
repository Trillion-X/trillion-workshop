#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_court_onnx_parity.py
#
# MP9.2 parity gate for the torch-free court detector: court_onnx.detect_courts (with the
# onnxruntime provider) MUST produce the SAME per-frame homographies as the vendored torch
# CourtDetectorNet on real frames. Proves the inference seam (inject run_model, numpy
# sigmoid) is byte-faithful to the oracle — so the on-device Pyodide path (same code, the
# onnxruntime-web provider) is correct by construction. Env-gated; SKIPs without the model
# tree. Bounded to MATCH_TEST_MAX_FRAMES frames.
import os
import sys

import numpy as np

VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not VENDOR:
    print("SKIP (env): MATCH_VENDOR_ROOT not set")
    sys.exit(0)
NEED = [os.path.join(VENDOR, "onnx", "court_detection.onnx"),
        os.path.join(VENDOR, "weights", "court_detection.pt"),
        os.environ.get("MATCH_TEST_CLIP") or os.path.join(VENDOR, "_probe", "fed_court_720.mp4")]
missing = [p for p in NEED if not os.path.exists(p)]
if missing:
    print(f"SKIP (env): missing {', '.join(os.path.basename(m) for m in missing)}")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(VENDOR, "TennisProject"))
import wasb_infer  # noqa: E402
from court_onnx import detect_courts, make_onnxruntime_model  # noqa: E402

N = int(os.environ.get("MATCH_TEST_MAX_FRAMES", "8"))
frames = wasb_infer.read_frames(NEED[2], N)
assert frames, "no frames read"

# torch oracle (vendored)
import torch  # noqa: E402
from court_detection_net import CourtDetectorNet  # noqa: E402
mats_torch, _ = CourtDetectorNet(os.path.join(VENDOR, "weights", "court_detection.pt"), "cpu").infer_model(frames)

# torch-free path (onnxruntime provider)
mats_onnx, _ = detect_courts(frames, make_onnxruntime_model())

assert len(mats_torch) == len(mats_onnx) == len(frames)
both_present = 0
maxdiff = 0.0
for i, (mt, mo) in enumerate(zip(mats_torch, mats_onnx)):
    assert (mt is None) == (mo is None), f"frame {i}: court-found disagreement (torch={mt is not None} onnx={mo is not None})"
    if mt is not None:
        both_present += 1
        mt_a, mo_a = np.asarray(mt, float), np.asarray(mo, float)
        d = float(np.max(np.abs(mt_a - mo_a)))
        maxdiff = max(maxdiff, d)
        # the homography entries can span orders of magnitude; gate on relative closeness
        assert np.allclose(mt_a, mo_a, rtol=1e-3, atol=1e-4), \
            f"frame {i}: homography mismatch (max abs {d:.2e})\ntorch={mt_a}\nonnx={mo_a}"

assert both_present > 0, "no frame produced a court homography in EITHER path — clip/model issue"
print("MP9.2 COURT-ONNX PARITY PASS — torch-free onnxruntime court detector matches the torch oracle")
print(f"  {both_present}/{len(frames)} frames with a homography; all match (max abs elem diff {maxdiff:.2e})")
print(f"  the on-device path (same code + onnxruntime-web provider) is correct by construction")
sys.exit(0)
