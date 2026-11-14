#!/usr/bin/env python3
"""Pure gate for the SSOT edge-clamp helper `window_preps` and its use in `ball_window_stream`.

Proves (no models, no clip): window_preps clamps missing neighbours to cur, and ball_window_stream
refactored to use it yields the EXACT same edge-clamped (prev,cur,next) window sequence as the
documented behaviour (i=0 prev==cur, last next==cur, middle==neighbours) — byte-identical.
This is the SSOT the browser one-behind push glue will reuse (so the clamp is one impl, L093).
"""
import os
# wasb_infer requires MATCH_VENDOR_ROOT at import (model path DATA). The functions under test
# (window_preps / prep_frame / ball_window_stream) never resolve a model — a dummy satisfies import.
os.environ.setdefault("MATCH_VENDOR_ROOT", "/tmp")
import numpy as np
import wasb_infer

CFG = {"inp_width": 512, "inp_height": 288}
fails = []
def T(name, cond):
    print(f"  {'PASS' if cond else 'FAIL'} {name}")
    if not cond:
        fails.append(name)

print("window_preps + ball_window_stream edge-clamp (SSOT)\n")

# 1. window_preps: missing prev -> cur; missing next -> cur; both present -> unchanged.
a, b, c = "prevP", "curP", "nextP"
T("both neighbours present -> unchanged", wasb_infer.window_preps(a, b, c) == (a, b, c))
T("missing prev (first frame) -> prev clamps to cur", wasb_infer.window_preps(None, b, c) == (b, b, c))
T("missing next (last frame) -> next clamps to cur", wasb_infer.window_preps(a, b, None) == (a, b, b))
T("single frame (both missing) -> (cur,cur,cur)", wasb_infer.window_preps(None, b, None) == (b, b, b))

# 2. ball_window_stream over synthetic frames: the (prev,cur,next) preps must equal prep_frame of
#    the EDGE-CLAMPED raw frames. Distinct frames so prep(fi) are distinguishable arrays.
def make_frame(fill):
    return np.full((6, 8, 3), fill, dtype=np.uint8)   # tiny BGR frame

frames = [make_frame(10), make_frame(20), make_frame(30)]   # f0,f1,f2
preps = [wasb_infer.prep_frame(f, CFG) for f in frames]

out = list(wasb_infer.ball_window_stream(iter(frames), CFG))
T("yields one window per frame (3)", len(out) == 3)

# expected clamp: 0 -> (p0,p0,p1); 1 -> (p0,p1,p2); 2 -> (p1,p2,p2)
expected = [
    (0, preps[0], preps[0], preps[1]),
    (1, preps[0], preps[1], preps[2]),
    (2, preps[1], preps[2], preps[2]),
]
ok = True
for (i, raw, pp, pc, pn), (ei, epp, epc, epn) in zip(out, expected):
    if i != ei or not (np.array_equal(pp, epp) and np.array_equal(pc, epc) and np.array_equal(pn, epn)):
        ok = False
        break
    # raw current frame is the un-prepped frame i (for the court detector)
    if not np.array_equal(raw, frames[i]):
        ok = False
        break
T("byte-identical edge-clamped window sequence (0->prev=cur, mid=neighbours, last->next=cur)", ok)

# 3. single-frame stream: one window, all three clamp to the same prep.
one = list(wasb_infer.ball_window_stream(iter([make_frame(7)]), CFG))
T("single-frame stream -> 1 window, prev==cur==next",
  len(one) == 1 and np.array_equal(one[0][2], one[0][3]) and np.array_equal(one[0][3], one[0][4]))

# 4. empty stream -> no windows (fail-closed).
T("empty stream -> 0 windows", list(wasb_infer.ball_window_stream(iter([]), CFG)) == [])

print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILED: ' + ', '.join(fails)}")
raise SystemExit(1 if fails else 0)
