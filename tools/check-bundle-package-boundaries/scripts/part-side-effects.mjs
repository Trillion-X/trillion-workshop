// scripts/part-side-effects.mjs
//
// Purpose: let a browser bundle leave out a part's modules nothing uses. A part that declares `side_effects` in its
// part.json says which of its files do something merely by being imported (a stylesheet); every other file of that
// part only defines things, so a bundle that imports the part's index for one component leaves the rest of the part
// out of the page. Without it, one import of a large part's index carries every module the index names.
//
// Non-negotiable invariants:
// - The declaration is the part's own DATA (`side_effects` in part.json: `*.ext` for every file ending so, or a path
//   inside the part); a part without it is bundled exactly as before.
// - The plugin never names a part: a part is any folder under the parts root carrying a part.json.
// - It only marks: a relative import inside a declaring part is resolved to the same file esbuild would pick (the
//   bundle's own extension order, then a folder's index), and anything it cannot find is left to esbuild.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json', '.css'];
const disk = { existsSync, readFileSync, statSync };
const isFile = (path, fs = disk) => fs.existsSync(path) && fs.statSync(path).isFile();

/** The file a relative import names, as the bundle resolves it: the path itself, then the bundle's extensions in order,
 *  then a folder's index; null when none is there. */
export function resolveLocal(base, { fs = disk } = {}) {
  if (isFile(base, fs)) return base;
  for (const extension of EXTENSIONS) if (isFile(base + extension, fs)) return base + extension;
  for (const extension of EXTENSIONS) if (isFile(join(base, `index${extension}`), fs)) return join(base, `index${extension}`);
  return null;
}

// Only the read view varies; declaration and resolution rules are shared with normal builds.
export function partSideEffectsPlugin(partsRoot, { fs = disk } = {}) {
  const declared = new Map();
  const declarationOf = name => {
    if (!declared.has(name)) {
      const file = resolve(partsRoot, name, 'part.json');
      const effects = isFile(file, fs) ? JSON.parse(fs.readFileSync(file, 'utf8')).side_effects : undefined;
      declared.set(name, Array.isArray(effects) ? effects.filter(item => typeof item === 'string') : null);
    }
    return declared.get(name);
  };
  const partOf = path => {
    const inside = relative(partsRoot, path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
    const [name, ...rest] = inside.split(sep);
    return rest.length ? { name, file: rest.join('/') } : null;
  };
  return {
    name: 'part-side-effects',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.?\// }, args => {
        if (args.namespace !== 'file' || !args.resolveDir) return undefined;
        const path = resolveLocal(resolve(args.resolveDir, args.path), { fs });
        const part = path && partOf(path);
        const effects = part && declarationOf(part.name);
        if (!effects || effects.some(pattern => (pattern.startsWith('*') ? part.file.endsWith(pattern.slice(1)) : part.file === pattern))) return undefined;
        return { path, sideEffects: false };
      });
    },
  };
}
