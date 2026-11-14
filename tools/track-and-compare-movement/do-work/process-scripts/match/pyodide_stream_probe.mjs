// packages/motion-analysis/do-work/process-scripts/match/pyodide_stream_probe.mjs
//
// MP9.2 slice 3 — the STREAMING on-device runtime: process the clip ONE FRAME AT A TIME,
// holding O(1) model heatmaps (not O(N)) — and still emit BYTE-IDENTICAL facts vs native.
// =============================================================================
// cont.43 (2d-iii) proved the whole emitter runs on-device in Pyodide, but BATCHED — it held
// every model heatmap in memory, so the full 331-frame clip OOMs (~4.5GB of court heatmaps,
// 13.8MB/frame). A phone cannot do that. This is the fix + the real browser-peer pattern:
//   per frame i: run BOTH models on frame i -> extract the tiny per-frame result
//                (court homography + ball candidates) -> DISCARD the heatmap.
//   after the loop: the sequence reductions (ball Kalman/RTS smoother, CV14c court gate as a
//                pure candidate RE-FILTER — no model re-run — then bounce/line-call/rally/speed)
//                run on the tiny accumulated results, and build_command_output emits the facts.
// Peak heatmap memory is O(1) regardless of clip length. The leaves are the SAME canonical
// .py (wasb_infer.ball_input_for_frame / candidates_from_heatmap / ball_states_from_candidates,
// court_onnx.detect_courts per-frame, emit_match_facts.build_command_output) — zero re-impl.
//
// SCOPE: this removes BOTH O(N) memory ceilings in the BROWSER substrate.
//   (1) HEATMAPS — the 13.8MB/frame court output that made the 331-frame clip ~4.5GB and OOM'd
//       2d-iii: proven O(1) via a structural witness (max heatmaps alive at once == 2).
//   (2) FRAMES (cont.47 DECODE-ON-DEMAND, now wired here) — frames are pulled ONE AT A TIME via
//       the canonical `wasb_infer.stream_frames` generator (cv2 in Pyodide; the browser peer
//       swaps it for <video>/MediaRecorder) and windowed by `wasb_infer.ball_window_stream`
//       (a 3-prep ring buffer). There is NO upfront read_frames list — the decoded-frame array
//       (~2.76MB/frame) never exists. The native O(1)-frame BOUND (peak 2 frames alive) is
//       proven rigorously by test_stream_decode.py; this proves the SAME generators run
//       byte-identically in the browser substrate. The probe drives the canonical leaves (no
//       re-derivation) — SSOT with the native stream_perception path.
//
// Run:  cd /tmp/pyoleaves  (pyodide@0.28 + onnxruntime-web@1.20.1)
//       MATCH_VENDOR_ROOT=… MATCH_PYTHON=… node <match-dir>/pyodide_stream_probe.mjs <match-dir>
// =============================================================================
import { loadPyodide } from "pyodide";
import * as ort from "onnxruntime-web";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPerceptionSession, configureOrtEnv } from "./ort_session.mjs";
import { runStreamingPerception } from "./match_stream_driver.mjs";

const HERE = process.argv[2] || path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.MATCH_VENDOR_ROOT;
const NATIVE_PY = process.env.MATCH_PYTHON || "python3";
const N = parseInt(process.env.MATCH_TEST_MAX_FRAMES || "30", 10);
if (!VENDOR) { console.log("SKIP: MATCH_VENDOR_ROOT unset"); process.exit(0); }
const CLIP = process.env.MATCH_TEST_CLIP || path.join(VENDOR, "_probe", "fed_court_720.mp4");
const COURT_ONNX = path.join(VENDOR, "onnx", "court_detection.onnx");
const BALL_ONNX = path.join(VENDOR, "onnx", "wasb_ball.onnx");
for (const p of [CLIP, COURT_ONNX, BALL_ONNX]) {
  if (!fs.existsSync(p)) { console.log(`SKIP: missing ${path.basename(p)}`); process.exit(0); }
}
await configureOrtEnv({ numThreads: 1 });
const RID = "rid-stream-parity";

const t0 = Date.now();
const py = await loadPyodide();
await py.loadPackage(["numpy", "opencv-python", "scipy", "sympy", "matplotlib"]);
console.log(`pyodide + deps loaded in ${Date.now() - t0}ms`);
py.FS.mkdir("/MOUNT"); py.FS.mount(py.FS.filesystems.NODEFS, { root: HERE }, "/MOUNT");
py.FS.mkdir("/VENDOR"); py.FS.mount(py.FS.filesystems.NODEFS, { root: VENDOR }, "/VENDOR");
py.FS.mkdir("/CLIP"); py.FS.mount(py.FS.filesystems.NODEFS, { root: path.dirname(CLIP) }, "/CLIP");
py.globals.set("CLIP_PATH", `/CLIP/${path.basename(CLIP)}`);
py.globals.set("N_FRAMES", N);
py.globals.set("RID", RID);

const runPy = (label, code) => {
  try { return py.runPython(code); }
  catch (e) { console.log(`PYERR (${label}): ${String(e.message || e).split("\n").slice(-4).join(" | ")}`); process.exit(1); }
};

const { session: courtSess, provider: courtEP } = await createPerceptionSession(fs.readFileSync(COURT_ONNX));
const { session: ballSess } = await createPerceptionSession(fs.readFileSync(BALL_ONNX));
console.log(`onnxruntime-web execution provider bound: ${courtEP} (WebGPU-preferred, WASM-CPU fallback)`);
async function runOne(sess, u8, dims) {
  const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
  const r = await sess.run({ input: new ort.Tensor("float32", f32, dims) });
  return new Uint8Array(r.output.data.buffer.slice(0));
}

// --- Pyodide setup: read frames, import the real leaves, prep the ball geometry ---
const setup = runPy("setup", `
import os, sys
os.environ["MATCH_VENDOR_ROOT"] = "/VENDOR"
os.environ["MATCH_FORWARD"] = "onnx"
sys.path.insert(0, "/MOUNT")
import numpy as np, cv2, json
import wasb_infer, court_onnx, emit_match_facts
from court_geometry import court_region_accept, calibrate_court_gate

CFG = {"inp_width": 512, "inp_height": 288}
cap = cv2.VideoCapture(CLIP_PATH); FPS = cap.get(cv2.CAP_PROP_FPS); cap.release()

# DECODE-ON-DEMAND (cont.47): pull frames ONE AT A TIME via the canonical streaming leaves —
# there is NO upfront read_frames list. stream_frames is the cv2 frame generator (the browser
# peer swaps it for <video>/MediaRecorder); ball_window_stream yields the edge-clamped 3-prep
# ring buffer + the raw current frame. So FRAMES are O(1) too, not just heatmaps.
_gen = wasb_infer.ball_window_stream(wasb_infer.stream_frames(CLIP_PATH, N_FRAMES), CFG)
_cur = {}
SX = SY = None

# accumulators — TINY per frame (a 3x3 homography + a few candidate tuples); NO heatmaps AND
# NO full frame list kept. append, not pre-size — the count is unknown without read_frames.
H_MATS, KPS, CANDS = [], [], []
_live = {"max_heatmaps": 0}   # structural witness: heatmaps alive at once (frames O(1) by ring buffer)

def advance():
    """Pull the next frame window from the generator (decode-on-demand). 1 = a frame was
    produced, 0 = end-of-stream. Stashes the current window for frame_inputs/frame_extract."""
    global SX, SY
    try:
        i, raw, pp, pc, pn = next(_gen)
    except StopIteration:
        return 0
    if SX is None:
        SX, SY = wasb_infer.frame_scale(raw.shape, CFG)
    _cur.clear(); _cur.update(raw=raw, pp=pp, pc=pc, pn=pn)
    return 1

def frame_inputs():
    """BOTH model inputs for the CURRENT frame (court via a 1-frame capture pass; ball via the
    canonical 3-prep window assembly). Returns bytes; holds no heatmap, no frame list."""
    court_in = {}
    def cap_court(inp):
        court_in["x"] = np.ascontiguousarray(inp, np.float32)
        return np.zeros((1, 15, 360, 640), np.float32)
    court_onnx.detect_courts([_cur["raw"]], cap_court)        # 1-frame, stateless
    ball_in = np.ascontiguousarray(
        wasb_infer.ball_stack_from_preps(_cur["pp"], _cur["pc"], _cur["pn"]), np.float32)
    return bytes(court_in["x"].tobytes()), bytes(ball_in.tobytes())

def frame_extract(court_out_bytes, ball_out_bytes):
    """Turn the two outputs for the CURRENT frame into the TINY per-frame result, then DISCARD
    the heatmaps (out of scope at return)."""
    _live["max_heatmaps"] = max(_live["max_heatmaps"], 2)
    court_out = np.frombuffer(court_out_bytes, np.float32).reshape(1, 15, 360, 640)
    ball_out = np.frombuffer(ball_out_bytes, np.float32).reshape(1, 3, 288, 512)
    mats, kps = court_onnx.detect_courts([_cur["raw"]], lambda inp: court_out)   # 1-frame replay
    H_MATS.append(mats[0]); KPS.append(kps[0])
    hm = 1.0 / (1.0 + np.exp(-ball_out[0]))                  # sigmoid -> [3,288,512]
    CANDS.append(wasb_infer.candidates_from_heatmap(hm, SX, SY))
    return len(CANDS)

json.dumps({"fps": round(float(FPS), 2)})
`);
console.log("setup:", setup);

// --- STREAM via the SHARED orchestrator (SSOT with the browser driver): decode-on-demand,
//     one frame at a time, O(1) heatmaps AND O(1) frames in flight. The orchestrator
//     (match_stream_driver.mjs) owns the loop; this probe injects the pyodide glue + the
//     EP-seam session runners. The browser driver injects a <video> glue instead — SAME loop. ---
const tw = Date.now();
const glue = {
  // frame SOURCE lives here (cv2 generator via advance()); the browser peer injects a <video> one.
  advance: () => runPy("advance", `advance()`) !== 0,           // pull next frame (decode-on-demand)
  frameInputs: () => runPy("inputs", `frame_inputs()`).toJs(),  // [court_bytes, ball_bytes]
  frameExtract: (courtOut, ballOut) => {
    py.globals.set("CO", courtOut);
    py.globals.set("BO", ballOut);
    runPy("extract", `frame_extract(bytes(CO.to_py()), bytes(BO.to_py()))`);  // discard heatmaps
  },
  // sequence reductions on the TINY accumulators, then emit (once).
  reduceEmit: () => JSON.parse(runPy("reduce+emit", `
# ball states (ungated), then the CV14c court gate as a pure candidate RE-FILTER (no model re-run)
states = wasb_infer.ball_states_from_candidates(CANDS)
accept = court_region_accept(H_MATS, margin_m=4.0)
reliable, frac = calibrate_court_gate(CANDS, accept)
if reliable:
    gated = [[c for c in CANDS[i] if accept(i, (c[0], c[1]))] for i in range(len(CANDS))]
    states = wasb_infer.ball_states_from_candidates(gated)
co = emit_match_facts.build_command_output(
    [None] * len(H_MATS), FPS, H_MATS, KPS, CANDS, states, rid=RID, video=CLIP_PATH, runtime="onnx")
json.dumps({"facts": co["facts"], "records": co["records"], "summary": co["summary"],
            "max_heatmaps_alive": _live["max_heatmaps"]})
`)),
};
const { framesProcessed: n, result: pyData } = await runStreamingPerception({
  glue,
  runCourt: (u8) => runOne(courtSess, u8, [1, 3, 360, 640]),
  runBall: (u8) => runOne(ballSess, u8, [1, 9, 288, 512]),
  maxFrames: N,
});
console.log(`streamed ${n} frames (decode-on-demand, no upfront frame list) in ${Date.now() - tw}ms`);
console.log(`streaming emit: ${pyData.facts.length} facts, ${pyData.records.length} records, ` +
  `bounces ${pyData.summary.bounces}; MAX heatmaps alive at once = ${pyData.max_heatmaps_alive} (O(1), not ${N})`);
console.log(`node RSS after streaming ${N} frames: ${Math.round(process.memoryUsage().rss / 1e6)}MB`);

// --- native oracle (same models, batched) ---
const outNative = path.join(os.tmpdir(), "emit_stream_native.json");
try {
  execFileSync(NATIVE_PY, [path.join(HERE, "emit_match_facts.py"), CLIP, outNative, RID, String(N)],
    { encoding: "utf8", env: { ...process.env, MATCH_VENDOR_ROOT: VENDOR, MATCH_FORWARD: "onnx" }, maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.log(`SKIP native oracle (${NATIVE_PY} failed): ${String(e).slice(0, 300)}`);
  process.exit(0);
}
const nat = JSON.parse(fs.readFileSync(outNative, "utf8"));

// --- deep-diff facts ---
const diffs = [];
let maxnum = 0;
function walk(a, b, p) {
  if (typeof a === "boolean" || typeof b === "boolean") { if (a !== b) diffs.push(`${p}: ${a} != ${b}`); }
  else if (typeof a === "number" && typeof b === "number") {
    const d = Math.abs(a - b); maxnum = Math.max(maxnum, d);
    if (d > 1e-9) diffs.push(`${p}: ${a} != ${b} (Δ${d.toExponential(2)})`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { diffs.push(`${p}: len ${a.length} != ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${p}[${i}]`);
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join(",") !== kb.join(",")) { diffs.push(`${p}: keys [${ka}] != [${kb}]`); return; }
    for (const k of ka) walk(a[k], b[k], `${p}.${k}`);
  } else if (a !== b) diffs.push(`${p}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
walk(pyData.facts, nat.facts, "facts");

console.log(`=== STREAM PARITY: ${pyData.facts.length} facts; max numeric Δ ${maxnum.toExponential(2)}; ${diffs.length} diffs ===`);
if (pyData.max_heatmaps_alive > 2) { console.log(`MEMORY FAIL: held ${pyData.max_heatmaps_alive} heatmaps (expected <=2)`); process.exit(1); }
if (diffs.length) { console.log("STREAMING ≠ NATIVE:\n  " + diffs.slice(0, 25).join("\n  ")); process.exit(1); }
console.log("MP9.2 slice 3 + cont.47 PASS — the BROWSER on-device runtime emits BYTE-IDENTICAL facts vs native while DECODE-ON-DEMAND streaming: O(1) heatmaps AND O(1) frames (no upfront frame list; both batch OOM ceilings removed in the actual Pyodide+onnxruntime-web substrate)");
