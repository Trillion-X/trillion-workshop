#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_onnx_parity.py
#
# MP9 parity gate — every exported .onnx MUST reproduce its torch oracle. Plan §10/§12.5:
# the on-device ONNX runtime is only valid if it emits the SAME perception as the Python
# oracle. This proves it at the model boundary for EVERY model in export_onnx.MODELS
# (court_detection, wasb_ball, …) with ONE generic check: feed the IDENTICAL real-frame
# tensor (the spec's make_input) to (a) the torch model and (b) the exported .onnx via
# onnxruntime, then assert:
#   GATE 1 (product output): the per-channel argmax PIXEL — the court keypoints / the
#           ball peak the tracker actually reads — is IDENTICAL for every channel.
#   GATE 2 (raw heatmap): the RELATIVE max diff < 1e-3 (an absolute bound is meaningless;
#           the nets emit un-normalized logits to ~1e4).
# Adding a model to export_onnx.MODELS auto-covers it here — zero new parity code (L069).
#
# Env-gated — SKIPS cleanly (exit 0) without MATCH_VENDOR_ROOT, the .onnx (run
# export_onnx.py first), or the probe clip. Never a false fail in a model-free env.
import os
import sys

import numpy as np

VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not VENDOR:
    print("SKIP (env): MATCH_VENDOR_ROOT not set — the model tree (Society home) is DATA")
    sys.exit(0)

sys.path.insert(0, os.path.join(VENDOR, "TennisProject"))
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402

from export_onnx import MODELS, ONNX_DIR  # reuse the model specs (SSOT)


def argmax_pixels(heatmap):
    """Per-channel argmax -> (x,y) pixel — the product output (court keypoints / ball peak)."""
    pts = []
    for i in range(heatmap.shape[0]):
        flat = int(np.argmax(heatmap[i]))
        pts.append((flat % heatmap.shape[2], flat // heatmap.shape[2]))
    return pts


def check_model(spec):
    name = spec["name"]
    onnx_path = os.path.join(ONNX_DIR, f"{name}.onnx")
    if not os.path.exists(onnx_path):
        print(f"SKIP {name}: {os.path.basename(onnx_path)} absent — run export_onnx.py {name}")
        return None
    x = spec["make_input"]()
    if x is None:
        print(f"SKIP {name}: no real input (probe clip absent)")
        return None

    model = spec["build"]()
    with torch.no_grad():
        torch_out = model(torch.from_numpy(x)).numpy()
    onnx_out = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"]).run(
        ["output"], {"input": x})[0]

    assert torch_out.shape == onnx_out.shape, f"{name}: shape {torch_out.shape} vs {onnx_out.shape}"
    kp_t, kp_o = argmax_pixels(torch_out[0]), argmax_pixels(onnx_out[0])
    n_diff = sum(a != b for a, b in zip(kp_t, kp_o))
    assert n_diff == 0, f"{name}: peak parity FAIL — {n_diff}/{len(kp_t)} channels' argmax differ"

    max_abs = float(np.max(np.abs(torch_out - onnx_out)))
    peak = float(np.max(np.abs(torch_out)))
    rel = max_abs / peak if peak else max_abs
    assert rel < 1e-3, f"{name}: heatmap relative parity FAIL — {rel:.2e} (abs {max_abs:.3f}/peak {peak:.1f})"
    print(f"  PASS {name}: {len(kp_t)}/{len(kp_t)} channel peaks pixel-identical; "
          f"raw rel diff {rel:.2e} (< 1e-3); out {tuple(torch_out.shape)}")
    return name


def main():
    print(f"MP9 ONNX parity gate (oracle = torch) over {len(MODELS)} model(s):")
    checked = [check_model(s) for s in MODELS]
    passed = [c for c in checked if c]
    if not passed:
        print("SKIP: no exported models present to verify (run export_onnx.py first)")
        sys.exit(0)
    print(f"MP9 ONNX PARITY PASS — {len(passed)}/{len(MODELS)} model(s) reproduce the torch oracle: {passed}")
    sys.exit(0)


if __name__ == "__main__":
    main()
