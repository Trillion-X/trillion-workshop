// packages/motion-analysis/do-work/process-scripts/match/pyodide_admission_bench.mjs
//
// MP9.2 ADMISSION GATE for the B runtime (the on-device perception decision).
// =============================================================================
// Plan §10 was SUPERSEDED (cont.37, Claude+Codex convergence): the customer-device
// runtime does NOT re-implement the perception leaves in JS (that is an SSOT/L029
// violation — two implementations of Kalman/BIC/line-call/homography/rally/speed
// kept in parity FOREVER). Instead the SAME canonical Python leaves run on-device
// via Pyodide (numpy + opencv-python in WASM), with ONLY the neural-net calls routed
// to onnxruntime-web/WebGPU (the 2 already-exported .onnx). Runtime = descriptor DATA.
//
// This benchmark proves the one GATING unknown of that decision: does Pyodide's
// opencv build actually expose the EXACT cv2 symbols the leaves call
// (resize / findHomography / perspectiveTransform) + numpy linalg — and how fast.
// If a symbol were missing, option B would be partially blocked. It is NOT a unit
// test of the leaves; it is the runtime-feasibility admission probe.
//
// Run:  mkdir -p /tmp/pyobench && cd /tmp/pyobench
//       echo '{"type":"module"}' > package.json
//       npm install pyodide@0.28.0
//       cp <this file> . && node pyodide_admission_bench.mjs
//
// RESULT (2026-06-29, Pyodide 0.28.0, Node 23): PASS — numpy 2.2.5 + cv2 4.11.0 load
//   (core 639ms; packages 4874ms cold from CDN, cached after). All symbols present:
//   resize=true (48ms), findHomography=true (2ms), perspectiveTransform=true (~0ms),
//   np.linalg.inv/solve=true (1ms). => Pyodide can run the leaves; option B is feasible.
//   STILL TO PROVE before B ships: onnxruntime-web inference called from Pyodide,
//   total bundle size, and real-phone FPS on a full clip.
// =============================================================================
import { loadPyodide } from "pyodide";

const t0 = Date.now();
const py = await loadPyodide();
console.log(`pyodide core loaded in ${Date.now() - t0}ms`);

const t1 = Date.now();
try {
  await py.loadPackage(["numpy", "opencv-python"]);
} catch (e) {
  console.log("LOADPACKAGE FAILED:", String(e).slice(0, 300));
  process.exit(2);
}
console.log(`numpy + opencv-python loaded in ${Date.now() - t1}ms`);

// Exercise the EXACT cv2/numpy operations the ported leaves depend on.
const res = py.runPython(`
import numpy as np, cv2, json, time
out = {"numpy": np.__version__, "cv2": cv2.__version__, "symbols": {}, "timings_ms": {}}

t = time.time()
img = (np.random.rand(720, 1280, 3) * 255).astype(np.uint8)
r = cv2.resize(img, (640, 360))                                  # frame preprocess
out["symbols"]["resize"] = bool(r.shape == (360, 640, 3)); out["timings_ms"]["resize"] = round((time.time()-t)*1000, 2)

t = time.time()
src = np.array([[0,0],[100,0],[100,100],[0,100]], np.float32)
dst = np.array([[10,10],[110,12],[108,108],[12,107]], np.float32)
H, _ = cv2.findHomography(src, dst)                              # court fit (court detector postprocess)
out["symbols"]["findHomography"] = bool(H is not None and H.shape == (3,3)); out["timings_ms"]["findHomography"] = round((time.time()-t)*1000, 2)

t = time.time()
pt = cv2.perspectiveTransform(np.array([[[50.0,50.0]]], np.float32), H.astype(np.float32))  # image->court projection
out["symbols"]["perspectiveTransform"] = bool(pt is not None and pt.shape == (1,1,2)); out["timings_ms"]["perspectiveTransform"] = round((time.time()-t)*1000, 2)

t = time.time()
M = np.random.rand(4,4); inv = np.linalg.inv(M); sol = np.linalg.solve(M, np.random.rand(4))  # Kalman/RTS smoother
out["symbols"]["np.linalg.inv/solve"] = bool(inv.shape == (4,4) and sol.shape == (4,)); out["timings_ms"]["linalg"] = round((time.time()-t)*1000, 2)

out["all_symbols_present"] = all(out["symbols"].values())
json.dumps(out)
`);
console.log("RESULT:", res);
const parsed = JSON.parse(res);
if (!parsed.all_symbols_present) {
  console.log("ADMISSION FAIL — a required cv2/numpy symbol is missing in Pyodide");
  process.exit(1);
}
console.log("ADMISSION PASS — Pyodide can run the perception leaves' cv2/numpy ops (option B feasible)");
