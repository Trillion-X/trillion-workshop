// Tests load the exact committed web modules that the Worker ships. The source fingerprint
// is checked first; stale modules are rebuilt by the normal build road or fail explicitly.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { withCommittedModules, COMPILED_MODULES, BUILT_CRATES_FOLDER } from '../build/compiled-modules.mjs';
const loaded = new Map();
export async function committedModuleForTests(crate) {
  if (!loaded.has(crate)) loaded.set(crate, withCommittedModules(async ({ fingerprint }) => {
    const entry = COMPILED_MODULES.find(row => row.crate === crate);
    if (!entry) throw new Error(`No committed web module for ${crate}.`);
    const stem = resolve(BUILT_CRATES_FOLDER, entry.folder, crate.replaceAll('-', '_'));
    const glue = pathToFileURL(`${stem}.js`);
    glue.searchParams.set('cohort', fingerprint);
    const bindings = await import(glue.href);
    const wasmBytes = await readFile(`${stem}_bg.wasm`);
    const module = new WebAssembly.Module(wasmBytes);
    bindings.initSync({ module });
    return { bindings, module, wasmBytes };
  }));
  return loaded.get(crate);
}
