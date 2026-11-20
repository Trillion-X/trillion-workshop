// packages/motion-analysis/do-work/process-scripts/match/pyodide_onnx_bridge_probe.mjs
//
// MP9.2 slice 1 — the on-device runtime INTEROP proof (cont.38). Plan §10 (superseded,
// cont.37) puts the canonical .py perception leaves on-device via Pyodide, routing ONLY
// the neural-net calls to onnxruntime-web/WebGPU. This probe proves that boundary works:
// Pyodide-Python (the leaves' runtime) builds a numpy input, passes it ACROSS THE BRIDGE
// to onnxruntime-web (JS), runs court_detection.onnx, gets the float32 output back as
// numpy, computes the court keypoints in Python, and parity-checks them against the
// Python-onnxruntime fixture (gen_court_onnx_fixture.py). 0/15 diff = the leaves can
// drive the browser neural-net provider with EXACT parity.
//
// Setup:
//   mkdir -p /tmp/pyobridge && cd /tmp/pyobridge && echo '{"type":"module"}' > package.json
//   npm install onnxruntime-web@1.20.1 pyodide@0.28.0
//   ONNX_DIR=$MATCH_VENDOR_ROOT/onnx python3 <pkg>/gen_court_onnx_fixture.py   # the oracle
//   cp <pkg>/pyodide_onnx_bridge_probe.mjs . && ONNX_DIR=$MATCH_VENDOR_ROOT/onnx node pyodide_onnx_bridge_probe.mjs
//
// RESULT (2026-06-29, onnxruntime-web 1.20.1 + Pyodide 0.28, Node 23): BRIDGE PARITY
//   PASS — 0/15 keypoints differ vs Python. (session 138ms; WASM-CPU-single-thread
//   inference ~5.5s/frame — WebGPU EP + SIMD/threads is far faster and is the product
//   target; perception runs OFFLINE on a recorded clip, court-detect on a frame subset.)
import { loadPyodide } from "pyodide";
import * as ort from "onnxruntime-web";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = fileURLToPath(new URL("./node_modules/onnxruntime-web/dist/", import.meta.url));
const DIR = process.env.ONNX_DIR;

const session = await ort.InferenceSession.create(readFileSync(`${DIR}/court_detection.onnx`),
  { executionProviders: ["wasm"] });
console.log("onnxruntime-web session ready");

const py = await loadPyodide();
await py.loadPackage(["numpy"]);

// The "run this model" capability the leaves call — float32 input bytes in, output bytes out.
py.registerJsModule("ortbridge", {
  runCourt: async (u8) => {
    const bytes = u8.toJs ? u8.toJs() : u8;
    const f32 = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const out = await session.run({ input: new ort.Tensor("float32", f32, [1, 3, 360, 640]) });
    return new Uint8Array(out.output.data.buffer.slice(0));
  },
});

const res = await py.runPythonAsync(`
import numpy as np, json
from ortbridge import runCourt
C,H,W = 3,360,640
xs = np.arange(W); ys = np.arange(H); grid = xs[None,:]*7 + ys[:,None]*13
inp = np.empty((1,C,H,W), np.float32)
for c in range(C): inp[0,c] = ((grid + c*101) % 251).astype(np.float32)
out_proxy = await runCourt(inp.tobytes())
arr = np.frombuffer(bytes(out_proxy.to_py()), dtype=np.float32).reshape(1,15,H,W)
json.dumps([[int(np.argmax(arr[0,i]))%W, int(np.argmax(arr[0,i]))//W] for i in range(15)])
`);

const kps = JSON.parse(res), fx = JSON.parse(readFileSync(`${DIR}/_court_fixture.json`));
let diff = 0;
for (let i = 0; i < 15; i++) if (kps[i][0] !== fx.keypoints[i][0] || kps[i][1] !== fx.keypoints[i][1]) diff++;
console.log(`Pyodide->onnxruntime-web->Pyodide keypoints differ: ${diff}/15 (vs Python fixture)`);
if (diff !== 0) { console.log("BRIDGE PARITY FAIL", kps.slice(0, 3), fx.keypoints.slice(0, 3)); process.exit(1); }
console.log("BRIDGE PARITY PASS — Pyodide-Python drives onnxruntime-web inference with exact parity");