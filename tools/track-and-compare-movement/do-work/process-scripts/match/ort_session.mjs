// packages/motion-analysis/do-work/process-scripts/match/ort_session.mjs
//
// CANONICAL on-device inference-provider seam — the ONE place any browser/Node
// onnxruntime-web session is created for the tennis match-perception runtime.
// =============================================================================
// WHY THIS EXISTS (the WebGPU-EP gap, done as a category fix not an instance flag):
//   The Pyodide + onnxruntime-web on-device runtime is proven byte-identical to
//   native, but every probe created its session as `ort.InferenceSession.create(bytes)`
//   with NO execution-provider policy -> it silently binds the WASM-CPU backend
//   (~3s/frame). Adding `executionProviders:["webgpu"]` to one probe would be an
//   INSTANCE fix (L063 violation): the next session, the next driver, the browser
//   app each re-decide the backend. Instead this module makes provider selection a
//   single DATA-selected, capability-probed, maximally-capable-default seam that
//   ALL sessions flow through (SSOT).
//
// NON-NEGOTIABLE INVARIANTS:
//   - L083 maximally-capable default: the default preference leads with the most
//     capable backend (WebGPU, phone-viable) and degrades to WASM-CPU, so a
//     zero-config caller automatically gets the best backend the device can run.
//   - L089 one code path: the backend is DATA (an ordered preference list) + a
//     runtime CAPABILITY PROBE, never a build-time branch. Dev and prod run the
//     same code; only the device's capabilities differ.
//   - L090 self-describing / generic handler: the loop NEVER switches on a fixed
//     enum of EP names. Each EP's availability comes from an injected probe map;
//     an EP with no probe is assumed available and guarded by try/catch. Adding a
//     future backend (e.g. "webnn", "coreml") = one DATA row, zero code change here.
//   - Provenance: the returned object names the EP that actually bound, so every
//     perceived fact downstream can carry which backend produced it (fail-closed
//     honesty — no silent "webgpu" label over a wasm run).
//   - Dependency-free policy: onnxruntime-web is imported LAZILY, only on the real
//     inference path. The selection POLICY (selectExecutionProviders +
//     createPerceptionSession with an injected tryCreate) runs with zero deps, so
//     it is unit-testable with plain node — no GPU, no model, no wheels.
//
// This is the browser peer of the native process-job's model load: the .py leaves
// + build_command_output stay the ONE canonical pipeline (proven byte-identical);
// only the neural FORWARD's backend is selected here.
// =============================================================================

/**
 * DEFAULT execution-provider preference — DATA, ordered most→least capable.
 * WebGPU first (phone/desktop GPU, ~real-time), WASM-CPU as the universal floor.
 * Callers/descriptors may override via opts.executionProviders.
 */
export const DEFAULT_EP_PREFERENCE = ["webgpu", "wasm"];

/**
 * Capability probes: EP name -> () => boolean. Pure, synchronous, cheap.
 * The map is DATA (injectable). An EP absent from the map is treated as
 * "assume available" and left to the try/catch backstop — so this is NOT a
 * closed enum of backends (enum-dissolution / L090).
 */
export const EP_CAPABILITY_PROBES = {
  // WebGPU requires a browser (or a WebGPU-polyfilled runtime) exposing navigator.gpu.
  webgpu: () => typeof navigator !== "undefined" && !!navigator.gpu,
  // WASM-CPU is the universal floor — always available where onnxruntime-web loads.
  wasm: () => true,
};

const firstLine = (e) => String(e?.message ?? e).split("\n")[0];

/**
 * Filter a preference list down to the EPs whose capability probe passes,
 * preserving order (most-capable-first). An EP with no probe is kept
 * (assume-available; try/catch is the real backstop).
 */
export function selectExecutionProviders(
  preference = DEFAULT_EP_PREFERENCE,
  probes = EP_CAPABILITY_PROBES,
) {
  return preference.filter((ep) => (probes[ep] ? !!probes[ep]() : true));
}

// One-time shared onnxruntime-web env config (threads / wasm asset path).
// Lazily imports ort; idempotent. Browser callers pass wasmPaths (the served
// asset dir); Node resolves from node_modules automatically.
let _envConfigured = false;
export async function configureOrtEnv(opts = {}) {
  if (_envConfigured) return;
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = opts.numThreads ?? 1;
  if (opts.simd !== undefined) ort.env.wasm.simd = opts.simd;
  if (opts.wasmPaths) ort.env.wasm.wasmPaths = opts.wasmPaths;
  _envConfigured = true;
}

// The real session constructor (lazy ort import — keeps the policy dep-free).
async function realTryCreate(modelBytes, ep) {
  const ort = await import("onnxruntime-web");
  return ort.InferenceSession.create(modelBytes, { executionProviders: [ep] });
}

/**
 * Create an onnxruntime-web session, binding the most capable available backend.
 *
 * @param {Uint8Array|ArrayBuffer} modelBytes  the .onnx model bytes
 * @param {object} [opts]
 * @param {string[]} [opts.executionProviders]  ordered preference (DATA); default WebGPU→WASM
 * @param {object}   [opts.capabilityProbes]    EP -> ()=>bool map (DATA/injected)
 * @param {(bytes,ep)=>Promise<any>} [opts.tryCreate]  injected constructor (test seam)
 * @returns {Promise<{session:any, provider:string, attempts:{ep:string,error:string}[]}>}
 *          `provider` = the EP that successfully constructed (provenance).
 * @throws  if no capable EP can bind (err.attempts lists every failure).
 */
export async function createPerceptionSession(modelBytes, opts = {}) {
  const preference = opts.executionProviders ?? DEFAULT_EP_PREFERENCE;
  const probes = opts.capabilityProbes ?? EP_CAPABILITY_PROBES;
  const tryCreate = opts.tryCreate ?? realTryCreate;

  const candidates = selectExecutionProviders(preference, probes);
  const attempts = [];
  for (const ep of candidates) {
    try {
      const session = await tryCreate(modelBytes, ep);
      return { session, provider: ep, attempts };
    } catch (e) {
      attempts.push({ ep, error: firstLine(e) });
    }
  }
  const err = new Error(
    `no execution provider bound (preference=[${preference.join(",")}], capable=[${candidates.join(",")}])`,
  );
  err.attempts = attempts;
  throw err;
}
