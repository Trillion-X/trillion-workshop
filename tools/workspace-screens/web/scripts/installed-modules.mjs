// scripts/installed-modules.mjs
//
// Purpose
//   Where this build finds the Workshop and the packages it bundles. The Workshop is the folder named trillion-workshop
//   by its package.json, found by walking up from the client's folder: the checkout or export this client sits in, or
//   node_modules/trillion-workshop in a consumer that installed the Workshop. Nothing links the Workshop to itself in
//   node_modules (the Mac's engine refuses a lock file with a link entry), so `trillion-workshop/...` is answered by
//   esbuild's `alias` to this folder (scripts/workshop-shell-imports.mjs) and, in these scripts, by relative paths. Other
//   packages come from the node_modules beside the Workshop, or the one holding it. The build never names where it
//   sits, so the same files build the client from either.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const WORKSHOP = 'trillion-workshop';

/** The Workshop's own folder: the nearest folder above `from` whose package.json is named trillion-workshop. */
export function workshopRoot(from) {
  for (let folder = from; ; folder = dirname(folder)) {
    const manifest = join(folder, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === WORKSHOP) return folder;
    if (dirname(folder) === folder) throw new Error(`No folder named ${WORKSHOP} by its package.json above ${from}.`);
  }
}

/** The node_modules that holds the build's other packages: the one the Workshop is installed in, else the one beside it. */
export function installedModules(from) {
  const workshop = workshopRoot(from);
  const holder = dirname(workshop);
  return basename(holder) === 'node_modules' ? holder : join(workshop, 'node_modules');
}
