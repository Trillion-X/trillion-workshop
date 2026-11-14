// packages/motion-analysis/do-work/process-scripts/match/test_ort_session.mjs
//
// Pure policy gate for the canonical on-device inference-provider seam (ort_session.mjs).
// Proves the WebGPU-preferred, capability-probed, maximally-capable-default backend
// selection + graceful fallback + provenance — with ZERO GPU, model, or wheels
// (onnxruntime-web is lazy-imported only on the real path; every test injects tryCreate
// and/or capability probes). Runs with plain node from anywhere.
//
//   node test_ort_session.mjs
// =============================================================================
import {
  DEFAULT_EP_PREFERENCE,
  EP_CAPABILITY_PROBES,
  selectExecutionProviders,
  createPerceptionSession,
} from "./ort_session.mjs";

let pass = 0, fail = 0;
const T = (n, c) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

console.log("ort_session — on-device execution-provider policy\n");

// 1. L083 maximally-capable default: WebGPU leads the default preference.
T("default preference leads with webgpu (maximally-capable default)",
  DEFAULT_EP_PREFERENCE[0] === "webgpu" && DEFAULT_EP_PREFERENCE.includes("wasm"));

// 2. Real Node runtime: no navigator.gpu -> webgpu filtered out -> only wasm survives.
//    (Proves the capability probe works in the ACTUAL runtime, not just via injection.)
const nodeSel = selectExecutionProviders();
T("in Node (no navigator.gpu) capability probe drops webgpu, keeps wasm",
  JSON.stringify(nodeSel) === JSON.stringify(["wasm"]));

// 3. When webgpu IS available, order is preserved (webgpu first).
const bothProbes = { webgpu: () => true, wasm: () => true };
T("with webgpu available, selection preserves order [webgpu, wasm]",
  JSON.stringify(selectExecutionProviders(DEFAULT_EP_PREFERENCE, bothProbes)) === JSON.stringify(["webgpu", "wasm"]));

// 4. Enum-dissolution: an EP with no probe is assumed available (no closed backend enum).
T("unknown EP with no capability probe is kept (assume-available, not a closed enum)",
  JSON.stringify(selectExecutionProviders(["webnn", "coreml"], {})) === JSON.stringify(["webnn", "coreml"]));

// 5. Fallback: webgpu capable but its constructor throws -> falls back to wasm; provenance = wasm.
{
  const tried = [];
  const tryCreate = async (_bytes, ep) => {
    tried.push(ep);
    if (ep === "webgpu") throw new Error("webgpu backend init failed");
    return { fakeSession: ep };
  };
  const r = await createPerceptionSession(new Uint8Array([1, 2, 3]),
    { capabilityProbes: bothProbes, tryCreate });
  T("fallback: webgpu ctor throws -> binds wasm, provider=wasm, attempts records webgpu",
    r.provider === "wasm" && r.attempts.length === 1 && r.attempts[0].ep === "webgpu"
    && JSON.stringify(tried) === JSON.stringify(["webgpu", "wasm"]));
}

// 6. Best-case: webgpu available AND constructs -> binds webgpu, never attempts wasm.
{
  const tried = [];
  const tryCreate = async (_bytes, ep) => { tried.push(ep); return { fakeSession: ep }; };
  const r = await createPerceptionSession(new Uint8Array([1]),
    { capabilityProbes: bothProbes, tryCreate });
  T("best-case: webgpu binds first, wasm never attempted, provider=webgpu",
    r.provider === "webgpu" && r.attempts.length === 0 && JSON.stringify(tried) === JSON.stringify(["webgpu"]));
}

// 7. All fail -> throws with every attempt recorded (fail-closed).
{
  const tryCreate = async (_bytes, ep) => { throw new Error(`${ep} down`); };
  let threw = null;
  try { await createPerceptionSession(new Uint8Array([1]), { capabilityProbes: bothProbes, tryCreate }); }
  catch (e) { threw = e; }
  T("all EPs fail -> throws, err.attempts lists both webgpu+wasm",
    !!threw && threw.attempts.length === 2
    && threw.attempts.map(a => a.ep).join(",") === "webgpu,wasm");
}

// 8. End-to-end in the REAL Node runtime (default probes) with an echo constructor:
//    webgpu is dropped by the real capability probe, so the bound provider is wasm.
{
  const tryCreate = async (_bytes, ep) => ({ fakeSession: ep });
  const r = await createPerceptionSession(new Uint8Array([9]), { tryCreate });
  T("real-runtime default: webgpu dropped by probe in Node -> provider=wasm",
    r.provider === "wasm");
}

// 9. Provenance object shape is complete (session + provider + attempts).
{
  const r = await createPerceptionSession(new Uint8Array([0]),
    { capabilityProbes: bothProbes, tryCreate: async (_b, ep) => ({ ep }) });
  T("returns {session, provider, attempts} provenance shape",
    r.session && typeof r.provider === "string" && Array.isArray(r.attempts));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
