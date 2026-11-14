#!/usr/bin/env python3
"""Byte-parity gate for the browser py-op backend's window decomposition (browser_perception_ops).

Proves (vendor/model-free, native): the browser ops' `ball_input` (prep each frame + edge-clamp via
window_preps + ball_stack_from_preps, driven by the JS one-behind lag with None at stream edges)
produces BYTE-IDENTICAL ball-model input to the canonical `wasb_infer.ball_window_stream` pull path.
So the browser's finer decomposition matches the proven cv2 windower exactly — and since the leaves
run byte-identical in Pyodide (pyodide_leaves_probe), it matches in-browser too.

court_input / extract / reduce_emit reuse the EXACT native stream python (proven byte-identical by
pyodide_stream_probe / pyodide_emit_probe with vendored models) — not re-tested here (vendor-gated).
"""
import os
os.environ.setdefault("MATCH_VENDOR_ROOT", "/tmp")  # wasb_infer import guard; prep/window are vendor-free
import numpy as np
import wasb_infer
import browser_perception_ops as ops

CFG = ops.CFG
fails = []
def T(name, cond):
    print(f"  {'PASS' if cond else 'FAIL'} {name}")
    if not cond:
        fails.append(name)

print("browser_perception_ops — ball window byte-parity vs ball_window_stream\n")

# Distinct synthetic BGR frames so each prep is a distinguishable array.
frames = [np.full((6, 8, 3), v, dtype=np.uint8) for v in (10, 20, 30, 40, 50)]
n = len(frames)

# Reference: the canonical cv2 pull windower's ball-model input per frame.
ref = list(wasb_infer.ball_window_stream(iter(frames), CFG))
ref_ball = [
    bytes(np.ascontiguousarray(wasb_infer.ball_stack_from_preps(pp, pc, pn), np.float32).tobytes())
    for (_i, _raw, pp, pc, pn) in ref
]
T("reference produced one ball input per frame", len(ref_ball) == n)

# Browser ops: prep each frame once, then window via ops.ball_input with None at the edges
# (exactly how the JS one-behind glue signals a missing neighbour).
preps = [ops.prep(f) for f in frames]
bo_ball = []
for i in range(n):
    prev_prep = preps[i - 1] if i > 0 else None
    next_prep = preps[i + 1] if i < n - 1 else None
    bo_ball.append(ops.ball_input(prev_prep, preps[i], next_prep))

T("browser ops produced one ball input per frame", len(bo_ball) == n)
T("ball input BYTE-IDENTICAL to ball_window_stream for every frame", bo_ball == ref_ball)

# Edge behaviour is exercised by the parity above (frame 0 prev=None, last next=None), but assert
# the clamp explicitly too: frame 0's window == (cur,cur,next), last == (prev,cur,cur).
first_expected = bytes(np.ascontiguousarray(
    wasb_infer.ball_stack_from_preps(preps[0], preps[0], preps[1]), np.float32).tobytes())
last_expected = bytes(np.ascontiguousarray(
    wasb_infer.ball_stack_from_preps(preps[n - 2], preps[n - 1], preps[n - 1]), np.float32).tobytes())
T("frame 0 clamps prev→cur (byte-identical)", bo_ball[0] == first_expected)
T("last frame clamps next→cur (byte-identical)", bo_ball[n - 1] == last_expected)

# Single-frame stream: one window, all three clamp to the same prep.
one = ops.ball_input(None, preps[0], None)
one_ref = bytes(np.ascontiguousarray(
    wasb_infer.ball_stack_from_preps(preps[0], preps[0], preps[0]), np.float32).tobytes())
T("single-frame window (all clamp to cur) byte-identical", one == one_ref)

# prep is the canonical leaf (identity with wasb_infer.prep_frame).
T("ops.prep == wasb_infer.prep_frame (same leaf, no re-impl)",
  np.array_equal(ops.prep(frames[0]), wasb_infer.prep_frame(frames[0], CFG)))

print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILED: ' + ', '.join(fails)}")
raise SystemExit(1 if fails else 0)
