// Every tool folder's rows, checked the way Trillion reads them before it offers a tool: each tools/<name>/tool-rows.json
// is { records: [{ payload }] }; a row's files (invoke.files.package_files) name a tool folder here and paths that are
// in it; a tool-row-source's list.records names a records file (or a folder of them) here holding rows of its kind; every licence class a
// row names is in licence-classes.json; no two rows share an id; and a folder with no row is a library some row
// packs. Nothing here names a tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, posix, resolve } from 'node:path';
import { folders, json, root, rows as readRows, tools } from '../test-helpers/tool-rows.mjs';

const classes = new Set(json(resolve(root, 'licence-classes.json')).records.map(record => record.payload.id));
const rows = readRows();

// A folder with no row of its own is a library: some row packs files from it (invoke.files.package_files).
const packed = new Set(rows.flatMap(({ payload }) => [payload.invoke?.files?.package_files ?? []].flat().map(item => item.package)));

test('every tool folder offers at least one row, or is a library a row packs', () => {
  for (const folder of folders) {
    assert.ok(rows.some(row => row.folder === folder) || packed.has(folder),
      `tools/${folder} offers no row and no row packs it: add a tool-rows.json`);
  }
});

test('no two rows share an id', () => {
  const seen = new Map();
  for (const { folder, payload } of rows) {
    assert.ok(!seen.has(payload.id), `${payload.id} is in both ${seen.get(payload.id)} and ${folder}`);
    seen.set(payload.id, folder);
  }
});

test('a row\'s files are in the tool folder it names, and its licence class is a listed one', () => {
  for (const { payload } of rows) {
    if (payload.licence_class) assert.ok(classes.has(payload.licence_class), `${payload.id}: ${payload.licence_class} is in licence-classes.json`);
    const specs = payload.invoke?.files?.package_files;
    if (!specs) continue;
    for (const spec of [specs].flat().filter(item => item.package !== undefined)) {
      assert.ok(folders.includes(spec.package), `${payload.id} takes files from ${spec.package}, which is not a folder in tools/`);
      for (const path of spec.paths) assert.ok(existsSync(join(tools, spec.package, path)), `${payload.id}: tools/${spec.package}/${path} exists`);
    }
  }
});

// Where each packed file lands when a row runs: { place in the run → the file here }. A path that is a folder packs
// every file under it.
function packedFiles(specs) {
  const placed = new Map();
  const lay = (here, there) => {
    if (!existsSync(here)) return;
    if (!statSync(here).isDirectory()) { placed.set(there, here); return; }
    for (const entry of readdirSync(here)) lay(join(here, entry), posix.join(there, entry));
  };
  for (const spec of specs) {
    // A module's files come from the install, which a fresh checkout may not have yet: its places count as packed.
    if (spec.module !== undefined) {
      for (const path of spec.paths ?? []) placed.set(posix.join(spec.at, path), null);
      continue;
    }
    for (const path of spec.paths ?? []) lay(join(tools, spec.package, path), posix.join(spec.at, path));
  }
  return placed;
}

// The modules a file asks for: static imports and re-exports, imports for effect, and dynamic imports of a literal.
// Comments are left out, so an example in a header is not taken for an import; a static import or re-export starts its
// line, and `import` must be a word of its own (not `x.import`).
function importsOf(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const asked = [...code.matchAll(/^\s*(?:import|export)\s[^'"`;()]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm), ...code.matchAll(/(?<![.\w$])import\(\s*['"]([^'"]+)['"]\s*\)/g)];
  return [...new Set(asked.map(match => match[1]))];
}

// The package a bare import names: `@scope/name/file.js` → `@scope/name`, `name/file.js` → `name`.
const packageOf = name => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/');

// The file a subpath of a module names: through its package.json `exports` (`./x` → its import or default target),
// else the subpath itself. A checkout without the install cannot read the map, so there the package.json stands in.
function moduleFile(owner, subpath) {
  const manifest = join(root, 'node_modules', owner, 'package.json');
  if (!existsSync(manifest)) return 'package.json';
  const target = json(manifest).exports?.[`./${subpath}`];
  const chosen = typeof target === 'string' ? target : target?.import ?? target?.default;
  return typeof chosen === 'string' ? posix.normalize(chosen) : subpath;
}

// Whether a run has `place`: packed itself, or under a module folder a row packs whole.
function packedAt(placed, place) {
  for (let at = place; at !== '/' && at !== '.'; at = posix.dirname(at)) if (placed.has(at) && (at === place || placed.get(at) === null)) return true;
  return false;
}

test('every import a row\'s run loads is packed by that row: its relative imports and its modules', () => {
  const missing = [];
  for (const { payload } of rows) {
    const specs = [payload.invoke?.files?.package_files ?? []].flat();
    if (!specs.length) continue;
    const placed = packedFiles(specs);
    // A run loads the packed files its argv names, then every file those import, and so on.
    const loaded = new Set();
    const load = there => {
      if (loaded.has(there) || !/\.(m?js|cjs)$/.test(there) || placed.get(there) === null) return;
      loaded.add(there);
      for (const name of importsOf(readFileSync(placed.get(there), 'utf8'))) {
        if (!name.startsWith('.')) {
          // A run has only what its row packs: Node finds a bare import in a node_modules folder beside the importing file
          // or in a folder above it, as the file the import names (a subpath) or the package's package.json.
          if (name.startsWith('node:') || builtinModules.includes(name)) continue;
          const owner = packageOf(name);
          const file = name === owner ? 'package.json' : moduleFile(owner, name.slice(owner.length + 1));
          const folders = posix.dirname(there).split('/').map((_, at, parts) => parts.slice(0, at + 1).join('/') || '/');
          if (!folders.some(folder => packedAt(placed, posix.join(folder, 'node_modules', owner, file)))) {
            missing.push(`${payload.id}: ${there} imports ${name}, and no node_modules above it holds ${owner}/${file}`);
          }
          continue;
        }
        const wanted = posix.join(posix.dirname(there), name);
        if (placed.has(wanted)) load(wanted);
        else missing.push(`${payload.id}: ${there} imports ${name}, and ${wanted} is not packed`);
      }
    };
    for (const word of [payload.invoke?.argv ?? []].flat()) if (typeof word === 'string' && placed.has(word)) load(word);
  }
  assert.deepEqual(missing, [], `a run would stop at a missing module:\n${missing.join('\n')}`);
});
