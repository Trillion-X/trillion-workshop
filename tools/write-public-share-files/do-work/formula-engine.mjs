// tools/write-public-share-files/do-work/formula-engine.mjs
//
// The Rust formula engine (tools/formula-engine, built to WebAssembly) for this tool: the rule compiler and the row
// filter a share's rules are decided by. The module is read once, the first time a rule is decided; a share with no
// rule never reads the engine's bytes.
//
// Invariants
//   - The engine decides every comparison. This file only loads it and passes requests through unchanged.
//   - Every call is synchronous; a refusal is thrown with the engine's own words.

import { readFileSync } from 'node:fs';
import { compileRules as compile, filterRecords as filter, initSync } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';

let ready = false;
const engine = () => {
  if (ready) return;
  initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
  ready = true;
};

/** {records, fields: [{id, kind, path?}], tree?} -> {total, matches, kept, records, reads, incomplete, error_rows, first_error}. */
export function filterRecords(request) {
  engine();
  return filter(request);
}

/** {tree, fields} -> {binding, reads, incomplete}; a null binding keeps every row. */
export function compileRules(request) {
  engine();
  return compile(request);
}
