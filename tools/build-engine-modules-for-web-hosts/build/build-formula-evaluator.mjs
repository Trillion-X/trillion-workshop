// build/build-formula-evaluator.mjs
//
// Purpose: rebuild the formula engine's row evaluator that trillion-workshop tools/formula-engine ships
// (built-stored-bytes/evaluate-over-rows/), in this Workshop checkout (--into <folder> names another), from the engine's
// crates, the engine checkout beside the Workshop (../trillion-rust/crates/evaluate-over-rows) over
// composition-ast and ops-core there, compiled for wasm32-unknown-unknown and bound with wasm-bindgen's `web`
// target, whose `initSync({ module })` loads the same way in a page, a Worker and Node.
// Run: node tools/build-engine-modules-for-web-hosts/build/build-formula-evaluator.mjs [--into <folder>]   (then commit the two files)
//
// Invariants:
// - The wasm-bindgen CLI must be the version the engine crates' Cargo.lock pins (checked by build-crate-for-a-web-host.mjs).
// - The module keeps its shipped name (`evaluate-over-rows.js`, `evaluate-over-rows_bg.wasm`), so every importer
//   (tools/formula-engine/rules/evaluate-over-rows.mjs) reads the rebuilt bytes unchanged.
// - Only the two module files are replaced; the part's README stays.

import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCrateForAWebHost, TOOLS } from './build-crate-for-a-web-host.mjs';

const into = process.argv.indexOf('--into');
const shipped = into > 0 ? resolve(process.argv[into + 1])
  : join(TOOLS, 'formula-engine/built-stored-bytes/evaluate-over-rows');

/** Build the evaluator and write it into the part; returns the written paths and the wasm size. */
export async function buildFormulaEvaluator() {
  const built = await buildCrateForAWebHost({
    crate: 'formula-engine-evaluate-over-rows',
    bindgenTarget: 'web',
    outName: 'evaluate-over-rows',
    typescript: false,
  });
  const wasm = join(shipped, 'evaluate-over-rows_bg.wasm');
  const glue = join(shipped, 'evaluate-over-rows.js');
  copyFileSync(built.wasmPath, wasm);
  copyFileSync(built.gluePath, glue);
  return { wasm, glue, bytes: built.wasmBytes.length, importModules: built.importModules };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { wasm, glue, bytes } = await buildFormulaEvaluator();
  process.stdout.write(`wrote ${wasm} (${bytes} bytes) and ${glue}\n`);
}
