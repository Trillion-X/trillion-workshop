#!/usr/bin/env python3
"""Browser on-device perception PY-OP backend — the per-frame Python operations the JS driver
(`match_perception_browser.makeVideoStreamGlue`) drives via Pyodide.

Same canonical leaves as the native worker; the ball window is edge-clamped via the SSOT
`wasb_infer.window_preps` (byte-identical to `ball_window_stream`, proven in test_window_preps).
These ops are PURE over their arguments — the JS wrapper holds the prep handles + the tiny
accumulators (H_MATS/KPS/CANDS) so frame memory stays O(1) (never the whole clip). This is the
finer-grained decomposition the browser needs (prep + window separately, driven by the JS
one-behind lag) vs the native `ball_window_stream` pull generator; both share prep_frame +
window_preps + ball_stack_from_preps, so there is ONE windowing impl (SSOT / L093).

`ball_input` + `prep` are vendor/model-free (pure wasb_infer prep) and are byte-parity-tested
natively here (test_browser_ops_parity.py). `court_input` / `extract` / `reduce_emit` reuse the
EXACT native stream python (court_onnx.detect_courts capture/replay, CV14c gate, build_command_output)
— proven byte-identical by pyodide_stream_probe / pyodide_emit_probe when the vendored models are
present. court_onnx / emit_match_facts / court_geometry are imported lazily so the vendor/model-free
ops (prep/ball_input) never pull the vendored postprocess dep closure.
"""
import numpy as np
import wasb_infer

CFG = {"inp_width": 512, "inp_height": 288}


def frame_scale(raw):
    """(sx, sy) model↔image scale from frame 0's shape (no whole-clip materialization)."""
    return wasb_infer.frame_scale(raw.shape, CFG)


def prep(raw):
    """Per-frame prep (BGR resize/normalize/BGR→RGB) — the ball-window unit. Vendor/model-free."""
    return wasb_infer.prep_frame(raw, CFG)


def ball_input(prep_prev, prep_cur, prep_next):
    """Ball model input bytes ([1,9,288,512] float32) for the CURRENT frame from the 3-prep
    window, edge-clamped via the SSOT window_preps — pass None for a missing neighbour at a
    stream edge (first→prev clamps to cur, last→next clamps to cur). Vendor/model-free."""
    pp, pc, pn = wasb_infer.window_preps(prep_prev, prep_cur, prep_next)
    stack = np.ascontiguousarray(wasb_infer.ball_stack_from_preps(pp, pc, pn), np.float32)
    return bytes(stack.tobytes())


def court_input(raw):
    """Court model input bytes for ONE raw frame — the capture pass (grabs the leaf's own
    preprocessed input; the model runs in JS/onnxruntime-web). Mirrors the native stream
    frame_inputs court capture exactly."""
    import court_onnx
    cap = {}

    def grab(inp):
        cap["x"] = np.ascontiguousarray(inp, np.float32)
        return np.zeros((1, 15, 360, 640), np.float32)

    court_onnx.detect_courts([raw], grab)
    return bytes(cap["x"].tobytes())


def new_accumulators():
    """The tiny per-clip accumulators the JS wrapper threads through extract → reduce_emit."""
    return {"H_MATS": [], "KPS": [], "CANDS": []}


def extract(court_out_bytes, ball_out_bytes, raw, sx, sy, acc):
    """Reduce ONE frame's model outputs into the tiny per-frame result (append to acc), discarding
    the heatmaps. Mirrors the native stream frame_extract byte-for-byte (court replay + numpy
    sigmoid + candidates_from_heatmap)."""
    import court_onnx
    court_out = np.frombuffer(court_out_bytes, np.float32).reshape(1, 15, 360, 640)
    ball_out = np.frombuffer(ball_out_bytes, np.float32).reshape(1, 3, 288, 512)
    mats, kps = court_onnx.detect_courts([raw], lambda inp: court_out)  # 1-frame replay
    acc["H_MATS"].append(mats[0])
    acc["KPS"].append(kps[0])
    hm = 1.0 / (1.0 + np.exp(-ball_out[0]))  # sigmoid → [3,288,512]
    acc["CANDS"].append(wasb_infer.candidates_from_heatmap(hm, sx, sy))
    return len(acc["CANDS"])


def reduce_emit(acc, fps, rid, video):
    """Sequence reductions on the tiny accumulators + build_command_output → {facts,records,summary}.
    Mirrors the native stream reduce+emit (CV14c court gate as a pure candidate re-filter, no model
    re-run)."""
    import emit_match_facts
    from court_geometry import court_region_accept, calibrate_court_gate

    CANDS, H_MATS, KPS = acc["CANDS"], acc["H_MATS"], acc["KPS"]
    states = wasb_infer.ball_states_from_candidates(CANDS)
    accept = court_region_accept(H_MATS, margin_m=4.0)
    reliable, _frac = calibrate_court_gate(CANDS, accept)
    if reliable:
        gated = [[c for c in CANDS[i] if accept(i, (c[0], c[1]))] for i in range(len(CANDS))]
        states = wasb_infer.ball_states_from_candidates(gated)
    return emit_match_facts.build_command_output(
        [None] * len(H_MATS), fps, H_MATS, KPS, CANDS, states, rid=rid, video=video, runtime="onnx")
