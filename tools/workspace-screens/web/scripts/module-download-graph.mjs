import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** Follow only static bundled imports: dynamic descendants prepare their own downloads when opened. */
export function staticModuleClosure(metafile, file, seen = new Set()) {
  if (seen.has(file)) return seen;
  const output = metafile.outputs[file];
  if (!output) throw new Error(`Module download dependency ${file} has no bundled output.`);
  seen.add(file);
  for (const item of output.imports ?? []) {
    if (item.kind === 'import-statement' && !item.external) staticModuleClosure(metafile, item.path, seen);
  }
  return seen;
}

/** Keep the caller's declared keys, matching esbuild's resolved source identity even through symlinked dependencies. */
export function moduleDownloadGraph({ metafile, root, sources, addressOf }) {
  const entries = new Map();
  for (const [file, output] of Object.entries(metafile.outputs)) {
    if (!output.entryPoint) continue;
    const path = resolve(root, output.entryPoint);
    // A harness may have an in-memory stdin entry; it cannot identify a declared on-disk module.
    if (!existsSync(path)) continue;
    const identity = realpathSync(path);
    if (entries.has(identity)) throw new Error(`Module download source ${output.entryPoint} has multiple bundled entry outputs.`);
    entries.set(identity, file);
  }
  return Object.fromEntries([...new Set(sources)].map(source => {
    const file = entries.get(realpathSync(resolve(root, source)));
    if (!file) throw new Error(`Declared module download source ${source} has no bundled entry output.`);
    return [source, [...staticModuleClosure(metafile, file)].map(addressOf)];
  }));
}
