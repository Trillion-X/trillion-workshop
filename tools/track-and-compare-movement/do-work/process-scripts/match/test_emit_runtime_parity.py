#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_emit_runtime_parity.py
#
# MP9.2 slice 2c gate: the LIVE emitter (emit_match_facts.py) must produce BYTE-IDENTICAL
# perception facts whether the neural FORWARD runs on torch (native worker, MATCH_FORWARD=
# torch) or onnxruntime (on-device, MATCH_FORWARD=onnx). This proves the on-device runtime
# is the SAME canonical pipeline — only the net call swaps (SSOT, not a second impl) — at
# the WHOLE-emitter level, not just per-model. The dashboard reads `records`; gating on the
# full `facts` (a superset of records) is the strongest contract.
#
# Env-gated; SKIPs without the model tree/clip. Bounded by MATCH_TEST_MAX_FRAMES.
import json
import os
import subprocess
import sys
import tempfile

VENDOR = os.environ.get("MATCH_VENDOR_ROOT")
if not VENDOR:
    print("SKIP (env): MATCH_VENDOR_ROOT not set")
    sys.exit(0)
PY = os.environ.get("MATCH_PYTHON") or sys.executable
NEED = [os.path.join(VENDOR, "onnx", "court_detection.onnx"),
        os.path.join(VENDOR, "onnx", "wasb_ball.onnx"),
        os.environ.get("MATCH_TEST_CLIP") or os.path.join(VENDOR, "_probe", "fed_court_720.mp4")]
missing = [p for p in NEED if not os.path.exists(p)]
if missing:
    print(f"SKIP (env): missing {', '.join(os.path.basename(m) for m in missing)}")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
CLIP = NEED[2]
MAXF = os.environ.get("MATCH_TEST_MAX_FRAMES", "20")


def run(forward):
    out = os.path.join(tempfile.gettempdir(), f"emit_runtime_parity_{forward}.json")
    env = dict(os.environ, MATCH_FORWARD=forward)
    r = subprocess.run([PY, os.path.join(HERE, "emit_match_facts.py"), CLIP, out, "rid-parity", MAXF],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0, f"emit ({forward}) failed: {r.stderr[-800:]}"
    with open(out) as f:
        return json.load(f)


a = run("torch")
b = run("onnx")
assert a["runtime"] == "torch" and b["runtime"] == "onnx", "runtime tag not threaded"
assert len(a["facts"]) == len(b["facts"]) > 0, f"fact count mismatch/empty: {len(a['facts'])} vs {len(b['facts'])}"
assert len(a["records"]) == len(b["records"]), "record count mismatch"

maxnum = [0.0]
diffs = []


def walk(x, y, path=""):
    if isinstance(x, bool) or isinstance(y, bool):
        if x != y:
            diffs.append(f"{path}: {x!r} != {y!r}")
    elif isinstance(x, (int, float)) and isinstance(y, (int, float)):
        d = abs(float(x) - float(y))
        maxnum[0] = max(maxnum[0], d)
        if d > 1e-6:
            diffs.append(f"{path}: {x} != {y} (Δ{d:.2e})")
    elif isinstance(x, list) and isinstance(y, list):
        if len(x) != len(y):
            diffs.append(f"{path}: len {len(x)} != {len(y)}")
            return
        for i, (u, v) in enumerate(zip(x, y)):
            walk(u, v, f"{path}[{i}]")
    elif isinstance(x, dict) and isinstance(y, dict):
        if x.keys() != y.keys():
            diffs.append(f"{path}: keys {set(x) ^ set(y)}")
            return
        for k in x:
            walk(x[k], y[k], f"{path}.{k}")
    else:
        if x != y:
            diffs.append(f"{path}: {x!r} != {y!r}")


walk(a["facts"], b["facts"], "facts")
assert not diffs, "on-device (onnx) facts diverge from the torch oracle:\n  " + "\n  ".join(diffs[:20])
print(f"MP9.2 EMIT-RUNTIME PARITY PASS — the live emitter is byte-identical across torch/onnx "
      f"forwards ({len(a['facts'])} facts, {len(a['records'])} records, max numeric Δ {maxnum[0]:.2e})")
