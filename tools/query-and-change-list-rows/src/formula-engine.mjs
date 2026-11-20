// src/formula-engine.mjs
//
// Purpose: the formula engine's Rust module (tools/formula-engine/built-stored-bytes/formula-engine) for this folder: the
// rule compiler a rollup's `where` goes through (list-rollups.mjs) and the evaluator a measure is worked out with
// (list-aggregates.mjs). Callers use the module directly; nothing is wrapped between them and the engine.
//
// Non-negotiable invariants:
//   1. One module instance per process. Node reads the module's wasm from the formula-engine folder the first time a call
//      needs it; a page loads it first with the module's own init, and the same instance then answers every call.
//   2. A refusal from the engine is thrown with the engine's own words; no call answers a guess.
import * as formula from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';

const builtin = name => globalThis.process?.getBuiltinModule?.(name);
let ready = false;

/** The formula engine, ready to call. */
export function formulaEngine() {
  if (!ready && builtin('node:fs')) {
    formula.initSync({ module: builtin('node:fs').readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
    ready = true;
  }
  return formula;
}
