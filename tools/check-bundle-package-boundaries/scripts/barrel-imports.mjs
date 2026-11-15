// scripts/barrel-imports.mjs
//
// Purpose: a browser bundle imports a part's index (`import { Button } from '../../ui'`) as if it imported the files
// the index names. With code splitting, every file an index names that some later screen uses was placed in a file the
// page loads first, because the page "reached" it through the index: the page's first load grew from 1.80 MB to 2.65 MB
// in five days (2026-09-30 to 2026-10-05) while no first-load code asked for most of it. This plugin rewrites, at build
// time, each import of a part's index into imports of the files that index takes each name from, so the bundle's graph
// carries only the edges the code uses. The source keeps importing the index.
//
// Non-negotiable invariants:
// - An index is any `index.ts` (or .tsx, .js, .mjs) inside a folder under the parts root that declares `side_effects` in
//   its part.json (scripts/part-side-effects.mjs): importing it does nothing but name files. No part is named here.
// - An installed package declaring `"sideEffects": false`, imported by its bare name, is read the same way through its
//   `module` entry file, from our own files and from the files of any installed package that declares it too.
// - Only names the index takes from another file with `export { ... } from` or `export * from` are moved; a name the
//   index defines itself, or one this cannot place, is still imported from the index, so nothing is ever lost.
// - `import { }` and `export { } from` are both rewritten. Type-only names are left out (the bundle drops types);
//   `import type` and `export type` lines are untouched.
// - An import of a JSON file is one module whether or not it says `with { type: 'json' }` (node needs the words, the
//   bundle reads JSON by its extension): the words are dropped, so a file imported both ways is carried once, not twice.
// - A JSON file a module imports by default and then only reads keys of (`clients.clients`, never `clients` alone, spread,
//   passed or iterated) is imported as a namespace instead, so the bundle carries only the top-level keys it reads. Any
//   other use of the name, anywhere in the file, leaves the import as it is. A `default` field must keep the default
//   import: a JSON namespace's `default` is the whole object, not that field.
// - The plugin is `.plugin`; `indexesNaming(file)` names the indexes a file is passed on through, so the part boundary
//   check (scripts/check-bundle-part-boundaries.mjs) still judges the edge the source wrote: through an index.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveLocal as resolveLocalOnDisk } from './part-side-effects.mjs';

const INDEX_NAMES = ['index.ts', 'index.tsx', 'index.js', 'index.mjs'];
const disk = { existsSync, readdirSync, readFileSync, statSync };
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const JSON_WORDS = /(['"][^'"\n]+\.json['"])\s*with\s*\{\s*type\s*:\s*['"]json['"]\s*\}/g;
const JSON_DEFAULT = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*(['"][^'"\n]+\.json['"])\s*;?/g;
const specifiersOf = list => list.split(',').map(one => one.trim()).filter(Boolean);

/** The names a module exports from its own declarations and `export { }` lists (not re-exports), read from its text. */
function ownExports(file, read = readFileSync) {
  const text = stripComments(read(file, 'utf8'));
  const names = new Set();
  for (const match of text.matchAll(/\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of text.matchAll(/\bexport\s+(?:const|let|var)\s*\{([^}]*)\}/g)) for (const one of specifiersOf(match[1])) names.add(one.split(':').pop().trim());
  for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const one of specifiersOf(match[1])) if (!one.startsWith('type ')) names.add(one.split(/\s+as\s+/).pop().trim());
  }
  if (/\bexport\s+default\b/.test(text)) names.add('default');
  return names;
}

// Source integrations bind reads without adding another import-rewrite implementation.
export function barrelImportsPlugin(partsRoot, { fs = disk } = {}) {
  const { existsSync, readdirSync, readFileSync, statSync } = fs;
  const isFile = path => existsSync(path) && statSync(path).isFile();
  const resolveLocal = base => resolveLocalOnDisk(base, { fs });
  const declared = new Map();
  const tables = new Map();
  const partIndex = path => {
    const inside = relative(partsRoot, path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
    const segments = inside.split(sep);
    if (segments.length < 2 || !INDEX_NAMES.includes(segments.at(-1))) return null;
    if (!declared.has(segments[0])) {
      const file = resolve(partsRoot, segments[0], 'part.json');
      declared.set(segments[0], isFile(file) && Array.isArray(JSON.parse(readFileSync(file, 'utf8')).side_effects));
    }
    return declared.get(segments[0]) ? path : null;
  };
  // An installed package that says importing it does nothing (`"sideEffects": false`) and is imported by its name alone:
  // its entry file is an index like a part's (lucide-react names every icon from one file).
  const packages = new Map();
  const packageIndex = (from, specifier) => {
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(specifier)) return null;
    for (let folder = dirname(from); ; folder = dirname(folder)) {
      const manifest = join(folder, 'node_modules', specifier, 'package.json');
      if (isFile(manifest)) {
        if (!packages.has(manifest)) {
          const read = JSON.parse(readFileSync(manifest, 'utf8'));
          const entry = typeof read.module === 'string' ? resolve(dirname(manifest), read.module) : null;
          packages.set(manifest, read.sideEffects === false && entry && isFile(entry) ? entry : null);
        }
        return packages.get(manifest);
      }
      if (dirname(folder) === folder) return null;
    }
  };
  // A file of an installed package that itself says importing it does nothing: its own imports of other such packages
  // (framer-motion's of motion-dom) are read through the same way, or a page that uses one of its names carries every
  // file the other package's index names.
  const owners = new Map();
  const sideEffectFree = file => {
    for (let folder = dirname(file); ; folder = dirname(folder)) {
      if (owners.has(folder)) return owners.get(folder);
      const manifest = join(folder, 'package.json');
      if (isFile(manifest)) {
        const read = JSON.parse(readFileSync(manifest, 'utf8'));
        if (typeof read.name !== 'string') continue;
        owners.set(folder, read.sideEffects === false);
        return read.sideEffects === false;
      }
      if (dirname(folder) === folder) return false;
    }
  };
  // Each name an index passes on: the file it comes from and the name it has there.
  const tableOf = index => {
    if (tables.has(index)) return tables.get(index);
    const text = stripComments(readFileSync(index, 'utf8'));
    const table = new Map();
    const from = specifier => resolveLocal(resolve(dirname(index), specifier));
    for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const file = from(match[2]);
      if (!file) continue;
      for (const one of specifiersOf(match[1])) {
        if (one.startsWith('type ')) continue;
        const [own, given = own] = one.split(/\s+as\s+/).map(part => part.trim());
        table.set(given, { file, name: own });
      }
    }
    for (const match of text.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
      const file = from(match[1]);
      if (!file) continue;
      for (const name of ownExports(file, readFileSync)) if (name !== 'default' && !table.has(name)) table.set(name, { file, name });
    }
    tables.set(index, table);
    return table;
  };
  // Where a name finally comes from: an index naming another index is followed to the file that defines the name.
  const placeThrough = placed => {
    for (let hops = 0; placed && hops < 8 && partIndex(placed.file); hops += 1) {
      const next = tableOf(placed.file).get(placed.name);
      if (!next) break;
      placed = next;
    }
    return placed;
  };
  const rewrite = (path, text) => {
    let changed = false;
    const plain = text.replace(JSON_WORDS, (_whole, quoted) => { changed = true; return quoted; });
    const keyed = plain.replace(JSON_DEFAULT, (whole, name, quoted, at) => {
      // Namespace exports represent an object's own fields. Array methods and
      // inherited properties belong to the default JSON value, not the module.
      const specifier = quoted.slice(1, -1);
      if (!specifier.startsWith('.')) return whole;
      let value;
      try { value = JSON.parse(readFileSync(resolve(dirname(path), specifier), 'utf8')); }
      catch { return whole; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return whole;
      const uses = [...plain.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))];
      const onlyKeys = uses.every(use => {
        if (use.index >= at && use.index < at + whole.length) return true;
        const key = /^\??\.\s*([A-Za-z_$][\w$]*)/.exec(plain.slice(use.index + name.length))?.[1];
        return key !== undefined && key !== 'default' && Object.hasOwn(value, key);
      });
      if (!onlyKeys) return whole;
      changed = true;
      return `import * as ${name} from ${quoted};`;
    });
    const out = keyed.replace(/\b(import|export)\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\3\s*;?/g, (whole, verb, list, _quote, specifier) => {
      const index = specifier.startsWith('.') ? partIndex(resolveLocal(resolve(dirname(path), specifier)) ?? '') : packageIndex(path, specifier);
      if (!index) return whole;
      const table = tableOf(index);
      const byFile = new Map();
      const kept = [];
      for (const one of specifiersOf(list)) {
        if (one.startsWith('type ')) continue;
        const [name, local = name] = one.split(/\s+as\s+/).map(part => part.trim());
        const placed = placeThrough(table.get(name));
        if (!placed) { kept.push(one); continue; }
        if (!byFile.has(placed.file)) byFile.set(placed.file, []);
        byFile.get(placed.file).push(placed.name === local ? local : `${placed.name} as ${local}`);
      }
      changed = true;
      const lines = [...byFile].map(([file, names]) => {
        let relativePath = relative(dirname(path), file).split(sep).join('/');
        if (!relativePath.startsWith('.')) relativePath = `./${relativePath}`;
        return `${verb} { ${names.join(', ')} } from ${JSON.stringify(relativePath)};`;
      });
      if (kept.length) lines.push(`${verb} { ${kept.join(', ')} } from ${JSON.stringify(specifier)};`);
      return lines.join(' ');
    });
    return changed ? out : null;
  };
  // Every index a declaring part holds, by the files each passes names on from (read once per part).
  const namedBy = new Map();
  const indexesOfPart = name => {
    if (namedBy.has(name)) return namedBy.get(name);
    const byFile = new Map();
    const walk = folder => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); continue; }
        if (!INDEX_NAMES.includes(entry.name) || !partIndex(path)) continue;
        for (const placed of tableOf(path).values()) {
          if (!byFile.has(placed.file)) byFile.set(placed.file, new Set());
          byFile.get(placed.file).add(path);
        }
      }
    };
    walk(resolve(partsRoot, name));
    namedBy.set(name, byFile);
    return byFile;
  };
  return {
    /** The indexes (absolute paths) that pass names on from `file`: the part boundary judges an edge to `file` as one
     *  through each of them, which is the edge the source wrote. */
    indexesNaming(file) {
      const inside = relative(partsRoot, file);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) return [];
      const byFile = indexesOfPart(inside.split(sep)[0]);
      const found = new Set();
      const add = named => { for (const index of byFile.get(named) ?? []) if (!found.has(index)) { found.add(index); add(index); } };
      add(file);
      return [...found];
    },
    plugin: { name: 'barrel-imports', setup(builder) {
      builder.onLoad({ filter: /\.(tsx?|jsx?|mjs)$/ }, args => {
        if (args.namespace !== 'file') return undefined;
        const installed = args.path.includes(`${sep}node_modules${sep}`);
        if (installed ? !sideEffectFree(args.path) : !args.path.startsWith(partsRoot.slice(0, partsRoot.lastIndexOf(sep)))) return undefined;
        const text = readFileSync(args.path, 'utf8');
        if (!/\b(import|export)\s*\{/.test(text) && !/\.json['"]/.test(text)) return undefined;
        const contents = rewrite(args.path, text);
        if (contents === null) return undefined;
        const extension = extname(args.path).slice(1);
        return { contents, loader: extension === 'mjs' ? 'js' : extension, resolveDir: dirname(args.path) };
      });
    } },
  };
}
