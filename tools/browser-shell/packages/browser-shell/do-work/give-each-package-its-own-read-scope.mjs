// packages/browser-shell/do-work/give-each-package-its-own-read-scope.mjs
//
// PURPOSE
//   A Vite plugin that lets a page outside Bitfield import package source
//   directly and have it read live runtime data. It applies the exact rule the
//   package entry builder applies (make-packages-match-their-source,
//   createPackageReadScopePlugin): when code inside packages/<name>/ imports
//   `@bitfield/runtime-kit/react`, it receives a read scope built from that
//   package's OWN declared inputs in its things-to-store-and-run.json. Nothing is
//   bundled but the input definitions; current values arrive over the runtime's
//   normal subscription.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A package only ever sees its own declared inputs. A same-named input in
//      another package cannot satisfy it.
//   2. No package, app or input is named here; the manifest is the only source.
//   3. The runtime kit resolves to ONE copy (its source), so every package and
//      the page share one connection and one set of stores.

import fs from 'node:fs';
import path from 'node:path';

const SCOPE_PREFIX = '\0bitfield-package-read-scope:';

export function givePackagesTheirOwnReadScope({packagesRoot, runtimeKitRoot}) {
  const packages = fs.realpathSync(packagesRoot);
  const runtimeKit = fs.realpathSync(runtimeKitRoot);
  const ownerOf = importer => {
    if (!importer) return null;
    let real;
    try { real = fs.realpathSync(importer.split('?')[0]); } catch { return null; }
    const relative = path.relative(packages, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative.split(path.sep)[0];
  };
  return {
    name: 'bitfield-package-read-scope',
    enforce: 'pre',
    config: () => ({optimizeDeps: {exclude: ['@bitfield/runtime-kit']}}),
    resolveId(source, importer) {
      if (source === '@bitfield/runtime-kit/internal/owner-surface') return path.join(runtimeKit, 'src', 'internal', 'owner-surface.ts');
      if (source === '@bitfield/runtime-kit/protocol') return path.join(runtimeKit, 'src', 'protocol', 'index.ts');
      if (source !== '@bitfield/runtime-kit/react') return null;
      const owner = ownerOf(importer);
      return owner ? SCOPE_PREFIX + owner : path.join(runtimeKit, 'src', 'react', 'index.ts');
    },
    load(id) {
      if (!id.startsWith(SCOPE_PREFIX)) return null;
      const name = id.slice(SCOPE_PREFIX.length);
      const manifest = JSON.parse(fs.readFileSync(path.join(packages, name, 'things-to-store-and-run.json'), 'utf8'));
      const things = (manifest.things ?? [])
        .filter(thing => thing.remove !== true && thing.payload?.kind === 'bitfield-input-descriptor')
        .map(({address, payload}) => ({type: 'record', address, payload}));
      return [
        `import { createReadScopeFromPackageData, createUseBitfieldData, createUseBitfieldFold } from '@bitfield/runtime-kit/internal/owner-surface';`,
        `const scope = createReadScopeFromPackageData(${JSON.stringify({package: name, things})});`,
        `export const useBitfieldData = createUseBitfieldData(scope);`,
        `export const useBitfieldFold = createUseBitfieldFold(scope);`,
      ].join('\n');
    },
    handleHotUpdate(context) {
      const changed = path.resolve(context.file);
      if (path.basename(changed) !== 'things-to-store-and-run.json') return;
      const owner = path.basename(path.dirname(changed));
      if (path.dirname(changed) !== path.join(packages, owner)) return;
      const module = context.server.moduleGraph.getModuleById(SCOPE_PREFIX + owner);
      if (!module) return;
      context.server.moduleGraph.invalidateModule(module);
      context.server.ws.send({type: 'full-reload', path: '*'});
      return [];
    },
  };
}
