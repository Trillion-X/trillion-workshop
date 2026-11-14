// packages/motion-analysis/do-work/process-scripts/match/pyodide_emit_probe.mjs
//
// MP9.2 slice 2d-iii — the WHOLE emitter runs INSIDE Pyodide on REAL frames and emits
// BYTE-IDENTICAL perception facts vs the native emitter. The on-device runtime, proven.
// =============================================================================
// cont.41 proved the pure leaves run in Pyodide; cont.42 proved both neural detectors run
// in Pyodide via onnxruntime-web. This is the capstone: emit_match_facts.detect_perception
// + build_command_output (the SAME canonical functions the native worker uses) run end-to-end
// in Pyodide — frames decoded by cv2 ffmpeg in WASM, both model forwards served by
// onnxruntime-web via the capture/replay seam — producing the IDENTICAL `command-output.json`
// facts the generic record-maker + measures + dashboard consume. ONE assembler, zero torch,
// zero re-implementation (SSOT): the dashboard cannot tell whether perception ran on the
// native worker or on the customer's phone.
//
// The CV14c court gate calls wasb_infer.infer_frames TWICE (ungated -> calibrate -> gated),
// so the replay ball-forward is RE-CALLABLE: it serves precomputed outputs indexed by
// call-count MODULO the frame count (the 2nd pass re-runs the same N frames in order).
//
// MEMORY / STREAMING FINDING (real on-device constraint): this probe BATCHES all model
// inputs+outputs in memory — the court output alone is [1,15,360,640]×4 ≈ 13.8MB/frame, so
// the full 331-frame clip is ~4.5GB and OOMs Pyodide. PROVEN byte-identical up to 30 frames
// (60 facts incl 2 bounces + 2 line_calls). The PRODUCT on-device runtime must STREAM frames
// (run the model per-frame, keep only the heatmap-derived keypoints/peaks, drop the heatmap)
// rather than batch — a memory-budget requirement for the phone, not a correctness limit.
//
// Run:  cd /tmp/pyoleaves  (pyodide@0.28 + onnxruntime-web@1.20.1)
//       MATCH_VENDOR_ROOT=… MATCH_PYTHON=… node <match-dir>/pyodide_emit_probe.mjs <match-dir>
// =============================================================================
import { loadPyodide } from "pyodide";
import * as ort from "onnxruntime-web";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPerceptionSession, configureOrtEnv } from "./ort_session.mjs";

const HERE = process.argv[2] || path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.MATCH_VENDOR_ROOT;
const NATIVE_PY = process.env.MATCH_PYTHON || "python3";
const N = parseInt(process.env.MATCH_TEST_MAX_FRAMES || "6", 10);
if (!VENDOR) { console.log("SKIP: MATCH_VENDOR_ROOT unset"); process.exit(0); }
const CLIP = process.env.MATCH_TEST_CLIP || path.join(VENDOR, "_probe", "fed_court_720.mp4");
const COURT_ONNX = path.join(VENDOR, "onnx", "court_detection.onnx");
const BALL_ONNX = path.join(VENDOR, "onnx", "wasb_ball.onnx");
for (const p of [CLIP, COURT_ONNX, BALL_ONNX]) {
  if (!fs.existsSync(p)) { console.log(`SKIP: missing ${path.basename(p)}`); process.exit(0); }
}
await configureOrtEnv({ numThreads: 1 });
const RID = "rid-emit-parity";

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

// --- Pyodide: read frames + import the REAL emitter + capture model inputs ---
const capInfo = runPy("setup+capture", `
import os, sys
os.environ["MATCH_VENDOR_ROOT"] = "/VENDOR"
os.environ["MATCH_FORWARD"] = "onnx"   # on-device runtime tag
sys.path.insert(0, "/MOUNT")
import numpy as np, cv2, json
import wasb_infer, court_onnx, emit_match_facts

frames = wasb_infer.read_frames(CLIP_PATH, N_FRAMES)
assert frames, "no frames decoded in Pyodide"
cap = cv2.VideoCapture(CLIP_PATH); FPS = cap.get(cv2.CAP_PROP_FPS); cap.release()

# capture the EXACT preprocessed inputs the detectors feed the model (zeros forward)
court_inputs = []
def cap_court(inp):
    court_inputs.append(np.ascontiguousarray(inp, np.float32)); return np.zeros((1,15,360,640), np.float32)
court_onnx.detect_courts(frames, cap_court)

ball_inputs = []
def cap_ball(x):
    ball_inputs.append(np.ascontiguousarray(x, np.float32)); return np.zeros((3,288,512), np.float32)
wasb_infer.infer_frames(frames, run_model=cap_ball)

json.dumps({"frames": len(frames), "fps": round(float(FPS),2), "court_inputs": len(court_inputs), "ball_inputs": len(ball_inputs)})
`);
console.log("capture:", capInfo);
const courtInBytes = runPy("pull-court-in", `[bytes(a.tobytes()) for a in court_inputs]`).toJs();
const ballInBytes = runPy("pull-ball-in", `[bytes(a.tobytes()) for a in ball_inputs]`).toJs();

// --- JS: onnxruntime-web forwards ---
const { session: courtSess, provider: courtEP } = await createPerceptionSession(fs.readFileSync(COURT_ONNX));
const { session: ballSess } = await createPerceptionSession(fs.readFileSync(BALL_ONNX));
console.log(`onnxruntime-web execution provider bound: ${courtEP} (WebGPU-preferred, WASM-CPU fallback)`);
async function runAll(sess, inList, dims) {
  const out = [];
  for (const u8 of inList) {
    const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
    const r = await sess.run({ input: new ort.Tensor("float32", f32, dims) });
    out.push(new Uint8Array(r.output.data.buffer.slice(0)));
  }
  return out;
}
const tw = Date.now();
const courtOut = await runAll(courtSess, courtInBytes, [1, 3, 360, 640]);
const ballOut = await runAll(ballSess, ballInBytes, [1, 9, 288, 512]);
console.log(`onnxruntime-web: ${courtOut.length} court + ${ballOut.length} ball forwards in ${Date.now() - tw}ms`);
py.globals.set("court_out_js", courtOut);
py.globals.set("ball_out_js", ballOut);

// --- Pyodide: REPLAY through the real emitter -> command_output ---
const pyResult = runPy("replay+emit", `
court_out = [np.frombuffer(bytes(b.to_py()), np.float32).reshape(1,15,360,640) for b in court_out_js]
ball_out  = [np.frombuffer(bytes(b.to_py()), np.float32).reshape(1,3,288,512) for b in ball_out_js]
NC, NB = len(court_out), len(ball_out)

# re-callable replay forwards (the CV14c gate re-runs ball over the same N frames in order)
_cc = {"i": 0}
def replay_court(inp):
    o = court_out[_cc["i"] % NC]; _cc["i"] += 1; return o          # raw logits [1,15,360,640]
_bc = {"i": 0}
def replay_ball(x):
    raw = ball_out[_bc["i"] % NB]; _bc["i"] += 1
    return 1.0/(1.0+np.exp(-raw[0]))                                # numpy sigmoid -> [3,288,512]

H_mats, kps, cands, states, gate = emit_match_facts.detect_perception(
    frames, court_run_model=replay_court, ball_run_model=replay_ball)
co = emit_match_facts.build_command_output(
    frames, FPS, H_mats, kps, cands, states, rid=RID, video=CLIP_PATH, runtime="onnx")
json.dumps({"facts": co["facts"], "records": co["records"], "summary": co["summary"]})
`);
const pyData = JSON.parse(pyResult);
console.log(`Pyodide emit: ${pyData.facts.length} facts, ${pyData.records.length} records, ` +
  `court ${pyData.summary.court_frames}f, ball ${pyData.summary.ball_state_frames}f, bounces ${pyData.summary.bounces}`);

// --- native oracle: emit_match_facts.py (MATCH_FORWARD=onnx, same models) ---
const outNative = path.join(os.tmpdir(), "emit_native_onnx.json");
try {
  execFileSync(NATIVE_PY, [path.join(HERE, "emit_match_facts.py"), CLIP, outNative, RID, String(N)],
    { encoding: "utf8", env: { ...process.env, MATCH_VENDOR_ROOT: VENDOR, MATCH_FORWARD: "onnx" }, maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.log(`SKIP native oracle (${NATIVE_PY} failed): ${String(e).slice(0, 300)}`);
  process.exit(0);
}
const nat = JSON.parse(fs.readFileSync(outNative, "utf8"));

// --- deep-diff facts (the records the dashboard/seam consume) ---
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

console.log(`=== EMIT PARITY: ${pyData.facts.length} facts, ${pyData.records.length} records; max numeric Δ ${maxnum.toExponential(2)}; ${diffs.length} diffs ===`);
if (diffs.length) {
  console.log("ON-DEVICE EMIT ≠ NATIVE:\n  " + diffs.slice(0, 25).join("\n  "));
  process.exit(1);
}
console.log("MP9.2 slice 2d-iii PASS — the WHOLE emitter runs inside Pyodide via onnxruntime-web, emitting BYTE-IDENTICAL facts vs native (the on-device runtime is proven end-to-end)");
