// build/build-timed-action.mjs
//
// Purpose: rebuild the timed-action engine that tools/run-work-later-or-on-a-repeat ships (built-stored-bytes/) from its
// one crate (tools/run-work-later-or-on-a-repeat/crates/timed-action), in this Workshop checkout (--into <folder> puts
// all three files in another), two ways:
// - timed_action.js and timed_action_bg.wasm: the crate's library compiled for wasm32-unknown-unknown and bound with
//   wasm-bindgen's `web` target, whose `initSync({ module })` loads the same way in a page, a Worker and Node; a caller
//   imports these and calls the engine directly;
// - timed-action.wasm: the crate's command compiled for wasm32-wasip2, the one component a computer runs for a
//   timed-action tool row (the WASI command reads its request on standard input).
// Run: node tools/build-engine-modules-for-web-hosts/build/build-timed-action.mjs [--into <folder>]   (then commit the three files)
//
// Invariants:
// - The wasm-bindgen CLI must be the version the crate's Cargo.lock pins (checked by build-crate-for-a-web-host.mjs).
// - Only the three built files are replaced; the folder's README stays.
// - The crate reads no host zone data: its zones are jiff's bundled tz database, compiled into both outputs.

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, withCrateBuilds } from './build-crate-for-a-web-host.mjs';

const CRATE = 'timed-action';
const TOOL = 'run-work-later-or-on-a-repeat';
const into = process.argv.indexOf('--into');
const built = join(TOOLS, TOOL, 'built-stored-bytes');
const shipped = into > 0 ? resolve(process.argv[into + 1]) : join(built, CRATE);
const components = into > 0 ? resolve(process.argv[into + 1]) : join(built, 'component');

/** Build the module and the component and write them into the folder; returns the written paths and sizes. */
export async function buildTimedAction() {
  return withCrateBuilds(async builds => {
    const web = await builds.webHost({ crate: CRATE, bindgenTarget: 'web', outName: 'timed_action', typescript: false, cargoArgs: [] });
    const { wasmPath } = builds.target({ crate: CRATE, target: 'wasm32-wasip2', cargoArgs: ['--bin', CRATE] });
    const component = join(wasmPath, '..', `${CRATE}.wasm`);
    mkdirSync(shipped, { recursive: true });
    mkdirSync(components, { recursive: true });
    const written = { wasm: join(shipped, 'timed_action_bg.wasm'), glue: join(shipped, 'timed_action.js'), component: join(components, `${CRATE}.wasm`) };
    copyFileSync(web.wasmPath, written.wasm);
    copyFileSync(web.gluePath, written.glue);
    copyFileSync(component, written.component);
    return { ...written, bytes: web.wasmBytes.length, componentBytes: readFileSync(component).length, importModules: web.importModules };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { wasm, glue, component, bytes, componentBytes, importModules } = await buildTimedAction();
  process.stdout.write(`wrote ${wasm} (${bytes} bytes), ${glue} and ${component} (${componentBytes} bytes)\n`);
  process.stdout.write(`module imports: ${importModules.join(', ') || '(none)'}\n`);
}
