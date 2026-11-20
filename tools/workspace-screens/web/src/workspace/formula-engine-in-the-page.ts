// src/workspace/formula-engine-in-the-page.ts
//
// PURPOSE
//   The Rust formula engine (trillion-workshop/tools/formula-engine, built to WebAssembly) for this page. The page starts
//   one load, the first time anything asks, and every later caller shares that one promise: a list's filter, a parts
//   screen's conditions, a computed column and a total all decide with the same loaded module, and its bytes are
//   fetched once.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file decides nothing. It loads the engine and hands out its functions (filterRecords, holds, evaluate, ...).
//   2. formulaEngine() refuses until loadFormulaEngine() has resolved; it never answers without the engine.
//   3. A failed load is forgotten, so the next caller tries again.

import init, * as engine from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import engineAddress from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm';

let loaded: Promise<void> | null = null;
let ready = false;

/** Loads the engine once for the page. Resolves when every engine function can answer. */
export function loadFormulaEngine(): Promise<void> {
  loaded ||= init({ module_or_path: engineAddress }).then(
    () => { ready = true; },
    error => { loaded = null; throw error; },
  );
  return loaded;
}

/** The loaded engine's functions. Throws until loadFormulaEngine() has resolved. */
export function formulaEngine(): typeof engine {
  if (!ready) throw new Error('The formula engine is not loaded yet: await loadFormulaEngine() first.');
  return engine;
}
