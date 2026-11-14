// packages/motion-analysis/do-work/process-scripts/match/pyodide_detectors_probe.mjs
//
// MP9.2 slice 2d-ii — BOTH NEURAL DETECTORS run INSIDE Pyodide on REAL frames, with the
// model FORWARD served by onnxruntime-web — parity vs the native onnxruntime oracle.
// =============================================================================
// cont.41 proved the pure leaves run in Pyodide; cont.38 proved onnxruntime-web reproduces
// the .onnx. This ties them: the actual `court_onnx.detect_courts` + `wasb_infer.infer_frames`
// ORCHESTRATION (real cv2 preprocess → model → sigmoid → keypoints/peaks → homography/track)
// runs end-to-end inside Pyodide on REAL decoded frames, with onnxruntime-web as the injected
// run_model — and matches the native onnxruntime-python pipeline.
//
// THE ASYNC SEAM (capture/replay): detect_courts/infer_frames call run_model SYNCHRONOUSLY,
// but onnxruntime-web is async. So we run the leaf in TWO passes:
//   pass 1 (capture): run_model records the exact preprocessed input (the leaf's own cv2
//                     preprocess) and returns a correctly-shaped zero tensor.
//   <JS>            : run the ort-web session on every captured input (async, batched).
//   pass 2 (replay) : run_model returns the precomputed output per call (in frame order).
// This is ALSO the real product architecture: the model runs in the JS/GPU layer
// (onnxruntime-web/WebGPU), the canonical .py leaves consume its outputs — zero torch,
// zero re-implementation, exact cv2 preprocess (frames decoded by the same cv2 ffmpeg in
// Pyodide — VideoCapture works in the opencv-python WASM build).
//
// Run:  cd /tmp/pyoleaves  (has pyodide@0.28 + onnxruntime-web@1.20.1 + numpy/opencv via pyodide)
//       MATCH_VENDOR_ROOT=… MATCH_PYTHON=… node <match-dir>/pyodide_detectors_probe.mjs <match-dir>
// =============================================================================
import { loadPyodide } from "pyodide";
import * as ort from "onnxruntime-web";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

const t0 = Date.now();
const py = await loadPyodide();
// The vendored court postprocess/homography leaves drag scipy (spatial.distance),
// sympy (geometry Line/Point2D in refine_kps) and matplotlib (court_reference) — all in
// the Pyodide package set. This IS the on-device court-leaf dependency closure.
await py.loadPackage(["numpy", "opencv-python", "scipy", "sympy", "matplotlib"]);
console.log(`pyodide + numpy + opencv + scipy + sympy + matplotlib loaded in ${Date.now() - t0}ms`);

// mount the leaf dir + the vendored model/postprocess tree + the clip dir into Pyodide.
// MATCH_VENDOR_ROOT inside Pyodide is the MOUNTED path (/VENDOR), not the host path — the
// leaves resolve postprocess/homography/court_reference from the mounted tree. Frames decode
// via cv2 ffmpeg in the opencv WASM build (proven: VideoCapture isOpened+read_ok in Pyodide).
py.FS.mkdir("/MOUNT");
py.FS.mount(py.FS.filesystems.NODEFS, { root: HERE }, "/MOUNT");
py.FS.mkdir("/VENDOR");
py.FS.mount(py.FS.filesystems.NODEFS, { root: VENDOR }, "/VENDOR");
py.FS.mkdir("/CLIP");
py.FS.mount(py.FS.filesystems.NODEFS, { root: path.dirname(CLIP) }, "/CLIP");
const clipName = path.basename(CLIP);

py.globals.set("VENDOR", "/VENDOR");
py.globals.set("CLIP_PATH", `/CLIP/${clipName}`);
py.globals.set("N_FRAMES", N);

// Surface Python errors cleanly — a bare runPython throw dumps the whole asm.js source.
const runPy = (label, code) => {
  try {
    return py.runPython(code);
  } catch (e) {
    console.log(`PYERR (${label}): ${String(e.message || e).split("\n").slice(-4).join(" | ")}`);
    process.exit(1);
  }
};

// --- Pyodide pass 1: read real frames + CAPTURE the exact model inputs (leaf preprocess) ---
const capInfo = runPy("pass1-capture", `
import os, sys
os.environ["MATCH_VENDOR_ROOT"] = VENDOR
sys.path.insert(0, "/MOUNT")
import numpy as np
import wasb_infer, court_onnx

frames = wasb_infer.read_frames(CLIP_PATH, N_FRAMES)
assert frames, "no frames decoded in Pyodide"

court_inputs = []
def cap_court(inp):
    court_inputs.append(np.ascontiguousarray(inp, np.float32))
    return np.zeros((1, 15, 360, 640), np.float32)
court_onnx.detect_courts(frames, cap_court)        # discard result; harvest inputs

ball_inputs = []
def cap_ball(x):
    ball_inputs.append(np.ascontiguousarray(x, np.float32))
    return np.zeros((3, 288, 512), np.float32)
wasb_infer.infer_frames(frames, run_model=cap_ball)  # discard; harvest inputs

import json
json.dumps({"frames": len(frames), "court_inputs": len(court_inputs), "ball_inputs": len(ball_inputs)})
`);
console.log("Pyodide pass 1 (decode + capture):", capInfo);

// pull captured inputs out as bytes (py bytes -> JS Uint8Array)
const courtInBytes = py.runPython(`[bytes(a.tobytes()) for a in court_inputs]`).toJs();
const ballInBytes = py.runPython(`[bytes(a.tobytes()) for a in ball_inputs]`).toJs();

// --- JS: run onnxruntime-web on every captured input ---
const { session: courtSess, provider: courtEP } = await createPerceptionSession(fs.readFileSync(COURT_ONNX));
const { session: ballSess } = await createPerceptionSession(fs.readFileSync(BALL_ONNX));
console.log(`onnxruntime-web execution provider bound: ${courtEP} (WebGPU-preferred, WASM-CPU fallback)`);

async function runAll(sess, inBytesList, dims) {
  const outBufs = [];
  for (const u8 of inBytesList) {
    const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
    const r = await sess.run({ input: new ort.Tensor("float32", f32, dims) });
    const data = r.output.data; // Float32Array
    outBufs.push(new Uint8Array(data.buffer.slice(0))); // copy out
  }
  return outBufs;
}
const tw = Date.now();
const courtOut = await runAll(courtSess, courtInBytes, [1, 3, 360, 640]);
const ballOut = await runAll(ballSess, ballInBytes, [1, 9, 288, 512]);
console.log(`onnxruntime-web ran ${courtOut.length} court + ${ballOut.length} ball forwards in ${Date.now() - tw}ms`);

// push outputs back into Pyodide
py.globals.set("court_out_js", courtOut);
py.globals.set("ball_out_js", ballOut);

// --- Pyodide pass 2: REPLAY the web outputs through the real leaves -> homographies + track ---
const pyResult = runPy("pass2-replay", `
import numpy as np, json
court_out = [np.frombuffer(bytes(b.to_py()), np.float32).reshape(1, 15, 360, 640) for b in court_out_js]
ball_out  = [np.frombuffer(bytes(b.to_py()), np.float32).reshape(1, 3, 288, 512) for b in ball_out_js]

_ci = iter(court_out)
def replay_court(inp):
    return next(_ci)                                  # raw logits [1,15,360,640]; detect_courts sigmoids

_bi = iter(ball_out)
def replay_ball(x):
    raw = next(_bi)                                   # onnxruntime-web logits [1,3,288,512]
    return 1.0/(1.0+np.exp(-raw[0]))                  # numpy sigmoid -> [3,288,512] (matches make_onnxruntime_model)

mats, kps = court_onnx.detect_courts(frames, replay_court)
cands, states = wasb_infer.infer_frames(frames, run_model=replay_ball)
out = {
  "mats": [None if m is None else np.asarray(m, float).tolist() for m in mats],
  "ball": [{"frame": s.frame, "xy": [float(s.xy[0]), float(s.xy[1])], "status": s.status} for s in states],
}
json.dumps(out)
`);
const pyData = JSON.parse(pyResult);
console.log(`Pyodide pass 2 (replay): ${pyData.mats.filter(Boolean).length}/${pyData.mats.length} court homographies, ${pyData.ball.filter(b => b.status === "observed").length} observed ball frames`);

// --- native oracle: the SAME pipeline via onnxruntime-python ---
const oracleCode = `
import os, sys, json
import numpy as np
os.environ["MATCH_VENDOR_ROOT"] = ${JSON.stringify(VENDOR)}
sys.path.insert(0, ${JSON.stringify(HERE)})
import wasb_infer, court_onnx
frames = wasb_infer.read_frames(${JSON.stringify(`${path.dirname(CLIP)}/${clipName}`)}, ${N})
mats, _ = court_onnx.detect_courts(frames, court_onnx.make_onnxruntime_model())
cands, states = wasb_infer.infer_frames(frames, run_model=wasb_infer.make_onnxruntime_model())
out = {
  "mats": [None if m is None else np.asarray(m, float).tolist() for m in mats],
  "ball": [{"frame": s.frame, "xy": [float(s.xy[0]), float(s.xy[1])], "status": s.status} for s in states],
}
print(json.dumps(out))
`;
let nat;
try {
  nat = JSON.parse(execFileSync(NATIVE_PY, ["-c", oracleCode], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim());
} catch (e) {
  console.log(`SKIP native oracle (${NATIVE_PY} failed): ${String(e).slice(0, 300)}`);
  process.exit(0);
}

// --- compare: court homographies + ball track ---
let fail = [];
// court: found-agreement + relative closeness on present homographies
let courtBoth = 0, courtMaxRel = 0;
if (pyData.mats.length !== nat.mats.length) fail.push(`court frame count ${pyData.mats.length} vs ${nat.mats.length}`);
for (let i = 0; i < Math.min(pyData.mats.length, nat.mats.length); i++) {
  const a = nat.mats[i], b = pyData.mats[i];
  if ((a === null) !== (b === null)) { fail.push(`court frame ${i}: found disagreement (native=${a !== null} pyodide=${b !== null})`); continue; }
  if (a !== null) {
    courtBoth++;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const av = a[r][c], bv = b[r][c];
      const rel = Math.abs(av - bv) / (Math.abs(av) + 1e-9);
      courtMaxRel = Math.max(courtMaxRel, rel);
    }
  }
}
if (courtBoth === 0) fail.push("no court homography in EITHER path");
if (courtMaxRel > 1e-2) fail.push(`court homography rel diff ${courtMaxRel.toExponential(2)} > 1e-2`);

// ball: status agreement + track xy within 1px
let ballMaxXy = 0, observed = 0;
if (pyData.ball.length !== nat.ball.length) fail.push(`ball frame count ${pyData.ball.length} vs ${nat.ball.length}`);
for (let i = 0; i < Math.min(pyData.ball.length, nat.ball.length); i++) {
  const a = nat.ball[i], b = pyData.ball[i];
  if (a.status !== b.status) fail.push(`ball frame ${i}: status ${a.status} vs ${b.status}`);
  if (a.status === "observed") observed++;
  ballMaxXy = Math.max(ballMaxXy, Math.abs(a.xy[0] - b.xy[0]), Math.abs(a.xy[1] - b.xy[1]));
}
if (ballMaxXy > 1.0) fail.push(`ball track drift ${ballMaxXy.toFixed(3)}px > 1px`);

console.log(`=== PARITY: court ${courtBoth}/${pyData.mats.length} homographies (max rel ${courtMaxRel.toExponential(2)}); ball ${observed} observed (max drift ${ballMaxXy.toFixed(3)}px) ===`);
if (fail.length) {
  console.log("DETECTORS-IN-PYODIDE FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("MP9.2 slice 2d-ii PASS — both detectors run inside Pyodide on real frames via onnxruntime-web, parity vs native");
