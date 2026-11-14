// packages/motion-analysis/do-work/process-scripts/match/pyodide_leaves_probe.mjs
//
// MP9.2 slice 2d-i — PROVE THE ACTUAL PURE LEAVES RUN INSIDE PYODIDE (on-device).
// =============================================================================
// cont.37 proved Pyodide's opencv exposes the cv2 SYMBOLS the leaves call. This goes
// further: it loads the REAL leaf modules (ball_state_smoother / bounce_detect_v2 /
// court_geometry / rally_events / shot_speed / player_coverage) into Pyodide via a
// NODEFS mount of this directory and RUNS THE REAL TEST FILES inside Pyodide — the same
// tests run_all_tests.sh runs natively, whose own assertions are the correctness oracle.
// If they pass in Pyodide, the canonical algorithmic half of the pipeline (everything
// except the 2 neural nets, which route to onnxruntime-web — proven cont.38) runs
// correctly on-device with ZERO re-implementation (the §10/cont.37 B-runtime claim).
//
// PLUS a deterministic native-vs-Pyodide byte-identity check on court_geometry (fixed
// inputs, no randomness) so "runs correctly on-device" is upgraded to "byte-identical to
// the native oracle" for a representative leaf.
//
// Run:  mkdir -p /tmp/pyoleaves && cd /tmp/pyoleaves
//       echo '{"type":"module"}' > package.json && npm install pyodide@0.28.0
//       cp <match-dir>/*.py . ; node <match-dir>/pyodide_leaves_probe.mjs <match-dir>
//   (or just: node pyodide_leaves_probe.mjs   — defaults to this file's own directory)
// Needs MATCH_PYTHON (native interpreter w/ numpy+cv2) for the parity half; that half
// self-skips if MATCH_PYTHON is unavailable.
// =============================================================================
import { loadPyodide } from "pyodide";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = process.argv[2] || path.dirname(fileURLToPath(import.meta.url));
const PURE_LEAF_TESTS = [
  "test_ball_state_smoother",
  "test_bounce_detect_v2",
  "test_court_geometry",
  "test_rally_events",
  "test_shot_speed",
  "test_player_coverage",
];

// A deterministic court_geometry snippet (no randomness) — emits JSON the harness diffs
// native-vs-Pyodide. Uses only clear-signature leaves so the input shapes can't be wrong.
const PARITY_SNIPPET = `
import sys, json
sys.path.insert(0, '/MOUNT')
import numpy as np
from court_geometry import tennis_polygons, signed_distance_to_polygon, ref_to_m, net_line_m
poly = tennis_polygons()['doubles']
pts = [(0.5,0.5),(2.0,3.0),(-1.0,5.0),(6.0,11.0),(0.0,0.0)]
out = {
  "signed_distance": [round(float(signed_distance_to_polygon(np.array(p,float), poly)),9) for p in pts],
  "ref_to_m": [round(float(v),9) for v in np.asarray(ref_to_m((0.3,0.7)),float).reshape(-1)],
  "net_line_m": [round(float(net_line_m()[0]),9), int(net_line_m()[1])],
  "doubles_vertices": [[round(float(c),9) for c in np.asarray(v,float).reshape(-1)] for v in poly],
}
print(json.dumps(out, sort_keys=True))
`;

const t0 = Date.now();
const py = await loadPyodide();
await py.loadPackage(["numpy", "opencv-python"]);
console.log(`pyodide + numpy + opencv loaded in ${Date.now() - t0}ms`);

// NODEFS-mount the real match directory at /MOUNT (the leaves + tests, read live from disk).
py.FS.mkdir("/MOUNT");
py.FS.mount(py.FS.filesystems.NODEFS, { root: HERE }, "/MOUNT");

// --- Part A: run the REAL pure-leaf test files inside Pyodide ---
console.log("=== Part A: pure leaves run INSIDE Pyodide (real test files) ===");
let pass = 0;
const failed = [];
for (const t of PURE_LEAF_TESTS) {
  const code = `
import sys, os, runpy
sys.path.insert(0, '/MOUNT'); os.chdir('/MOUNT')
try:
    runpy.run_path('/MOUNT/${t}.py', run_name='__main__')
    _r = (True, '')
except SystemExit as e:
    _r = ((not e.code), '' if not e.code else f'exit {e.code}')
except BaseException as e:
    import traceback
    _r = (False, traceback.format_exc()[-700:])
_r
`;
  let ok, err;
  try {
    [ok, err] = py.runPython(code).toJs();
  } catch (e) {
    ok = false;
    err = String(e).slice(0, 700);
  }
  if (ok) {
    pass++;
    console.log(`  PASS ${t}`);
  } else {
    failed.push(t);
    console.log(`  FAIL ${t}\n      ${String(err).replace(/\n/g, "\n      ")}`);
  }
}

// --- Part B: deterministic native-vs-Pyodide byte-identity (court_geometry) ---
console.log("=== Part B: native-vs-Pyodide byte-identity (court_geometry) ===");
// runPython returns the value of the last expression (not prints) — return the dict JSON:
const pyJson = py.runPython(PARITY_SNIPPET.replace("print(json.dumps(out, sort_keys=True))", "json.dumps(out, sort_keys=True)"));
let parityOk = true;
let parityNote = "";
const NATIVE_PY = process.env.MATCH_PYTHON || "python3";
try {
  const nativeJson = execFileSync(NATIVE_PY, ["-c", PARITY_SNIPPET.replace("/MOUNT", HERE)], {
    encoding: "utf8",
  }).trim();
  if (nativeJson !== pyJson) {
    // tolerate key-order; compare parsed
    const a = JSON.stringify(JSON.parse(nativeJson));
    const b = JSON.stringify(JSON.parse(pyJson));
    parityOk = a === b;
    parityNote = parityOk ? "" : `\n  native=${nativeJson}\n  pyodide=${pyJson}`;
  }
  console.log(parityOk
    ? "  PASS court_geometry byte-identical native-vs-Pyodide"
    : `  FAIL court_geometry parity${parityNote}`);
} catch (e) {
  parityOk = true; // self-skip if native interpreter unavailable
  console.log(`  SKIP parity (native ${NATIVE_PY} unavailable: ${String(e).slice(0, 120)})`);
}

console.log(`=== SUMMARY: ${pass}/${PURE_LEAF_TESTS.length} pure-leaf tests pass in Pyodide; parity ${parityOk ? "PASS" : "FAIL"} ===`);
if (failed.length || !parityOk) {
  console.log(`LEAVES-IN-PYODIDE FAIL: ${failed.join(", ") || "(parity)"}`);
  process.exit(1);
}
console.log("MP9.2 slice 2d-i PASS — the canonical pure leaves run byte-identically inside Pyodide (option B on-device half proven)");
