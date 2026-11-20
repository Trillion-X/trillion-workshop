// build/output-root.mjs
//
// Purpose: the one place that says where this tool writes its outputs: `built-stored-bytes/` (the published crate-built
// modules) and `target/web-host-bindings/` (the wasm-bindgen output of each build). Production writes beside this tool.
// BUILD_ENGINE_MODULES_OUT names another folder, and every build and publication then writes there instead; the tests
// set it to a folder of their own (test/isolated-output.mjs), so no test writes into the checkout.
//
// Invariants:
// - Read at each use, never cached at import, so a test can set the variable before it builds.
// - Only the outputs above follow the root. Inputs (the crates, the Workshop's tools/ folder, the engine checkout) are
//   always read from where they are.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This tool's folder: the default output root and the folder every crate's path is named from. */
export const BUILD_TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The environment variable that moves every output of this tool into another folder (tests only). */
export const OUTPUT_ROOT_VARIABLE = 'BUILD_ENGINE_MODULES_OUT';

/** The folder every output of this tool is written under. */
export function outputRoot(env = process.env) {
  return env[OUTPUT_ROOT_VARIABLE] ? resolve(env[OUTPUT_ROOT_VARIABLE]) : BUILD_TOOL;
}
