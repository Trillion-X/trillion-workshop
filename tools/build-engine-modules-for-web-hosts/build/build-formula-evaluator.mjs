// build/build-formula-evaluator.mjs
//
// Purpose: rebuild the formula engine that trillion-workshop tools/formula-engine ships (built-stored-bytes/formula-engine/)
// and built-stored-bytes/component/ from its one crate (tools/formula-engine/crates/formula-engine), in this Workshop
// checkout (--into <folder> puts all three files in another), two ways:
// - formula_engine.js and formula_engine_bg.wasm: the crate's library compiled for wasm32-unknown-unknown and bound with
//   wasm-bindgen's `web` target, whose `initSync({ module })` loads the same way in a page, a Worker and Node; every
//   caller imports these and calls the engine directly;
// - formula-engine.wasm: the crate's command compiled for wasm32-wasip2, the one component the engine runs for the
//   formula tool rows on any computer (trillion-rust src/tool_runs/tools/component.rs).
// Run: node tools/build-engine-modules-for-web-hosts/build/build-formula-evaluator.mjs [--into <folder>]   (then commit the three files)
//
// Invariants:
// - The wasm-bindgen CLI must be the version the crate's Cargo.lock pins (checked by build-crate-for-a-web-host.mjs).
// - Only the three built files are replaced; the folder's README stays.

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, withCrateBuilds } from './build-crate-for-a-web-host.mjs';

const CRATE = 'formula-engine';
const into = process.argv.indexOf('--into');
const built = join(TOOLS, 'formula-engine/built-stored-bytes');
const shipped = into > 0 ? resolve(process.argv[into + 1]) : join(built, 'formula-engine');
const components = into > 0 ? resolve(process.argv[into + 1]) : join(built, 'component');

/** Build the module and the component and write them into the folder; returns the written paths and sizes. */
export async function buildFormulaEvaluator() {
  return withCrateBuilds(async builds => {
    const built = await builds.webHost({ crate: CRATE, bindgenTarget: 'web', outName: 'formula_engine', typescript: false, cargoArgs: [] });
    const { wasmPath } = builds.target({ crate: CRATE, target: 'wasm32-wasip2', cargoArgs: ['--bin', CRATE] });
    const component = join(wasmPath, '..', `${CRATE}.wasm`);
    mkdirSync(shipped, { recursive: true });
    mkdirSync(components, { recursive: true });
    const written = { wasm: join(shipped, 'formula_engine_bg.wasm'), glue: join(shipped, 'formula_engine.js'), component: join(components, `${CRATE}.wasm`) };
    copyFileSync(built.wasmPath, written.wasm);
    copyFileSync(built.gluePath, written.glue);
    copyFileSync(component, written.component);
    return { ...written, bytes: built.wasmBytes.length, componentBytes: readFileSync(component).length, importModules: built.importModules };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { wasm, glue, component, bytes, componentBytes } = await buildFormulaEvaluator();
  process.stdout.write(`wrote ${wasm} (${bytes} bytes), ${glue} and ${component} (${componentBytes} bytes)\n`);
}
