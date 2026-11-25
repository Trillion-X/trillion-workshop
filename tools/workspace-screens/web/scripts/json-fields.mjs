// scripts/json-fields.mjs
//
// Purpose: a page that imports a JSON file and reads a few fields of each item carries only those fields. The screens
// list (records/workshop-screen-tool-records.json) rides in the workspace's first load, and each screen row is a whole
// Workshop tool descriptor (its record envelope, maker, licence, status, needs) of which the page reads its words and
// its screen: the first load grew about 1 kB with every screen added and passed its budget on 2026-10-06. The fields a
// page reads are DATA (scripts/browser-json-fields.json); this plugin gives the bundle that projection of the file.
//
// Non-negotiable invariants:
// - No file or field is named here: each comes from scripts/browser-json-fields.json.
// - Only the bundle sees the projection, and only for the modules the entry names in `read_by`: any other module of the
//   page that imports the same file gets it whole. Node and the server import the file whole.
// - An item keeps exactly the declared paths it has (a path an item lacks is left out, never filled), in the item's
//   own nesting; every key of the file outside the list is left out. A `*` step keeps those fields of every item of
//   a nested list, in order, and nothing else of them.
// - An entry that names `item_when` ({ path, equals }) carries only the items whose value at `path` equals `equals`:
//   a page that reads one kind of row of a mixed list (a part's manifest, read for its provider icons) carries that
//   kind alone.
// - An entry that names `omit` (and no `list`) carries the whole file but those top-level keys: a page carries a
//   settings file without the file's own description (`_what`), which no page reads. A key added to the file later is
//   carried, so leaving one out is always a declared choice.
// - `projectJson(spec, value)` is the same projection the bundle gets, so a test can compare what a reader answers
//   from it with what it answers from the whole file.
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// A path step meaning every item of a list: ["tokens", "*", "value"] keeps each token's value and nothing else of it.
const EVERY_ITEM = '*';

/** The value at `path`; a `*` step reads that step of every item of a list, answering the list of what each has. */
export const at = (value, path) => {
  let inner = value;
  for (const [index, key] of path.entries()) {
    if (inner == null) return undefined;
    if (key === EVERY_ITEM) return Array.isArray(inner) ? inner.map(item => at(item, path.slice(index + 1))) : undefined;
    inner = inner[key];
  }
  return inner;
};

/** Copy what `source` has at `path` into `target`, in the same nesting (a `*` step keeps every item of a list). */
function keepAt(source, target, path) {
  const [key, ...rest] = path;
  if (key === EVERY_ITEM) {
    if (!Array.isArray(source)) return target;
    const items = Array.isArray(target) ? target : source.map(() => undefined);
    source.forEach((item, index) => { items[index] = rest.length ? keepAt(item, items[index], rest) : item; });
    return items;
  }
  if (source == null || typeof source !== 'object' || !(key in source)) return target;
  const out = target ?? {};
  out[key] = rest.length ? keepAt(source[key], out[key], rest) : source[key];
  return out;
}

function placeAt(target, path, value) {
  let inner = target;
  for (const key of path.slice(0, -1)) inner = inner[key] ??= {};
  inner[path[path.length - 1]] = value;
}

/** Whether a page carries `item` at all: every item, unless the entry's `item_when` names the one kind it reads. */
export const carriedItem = (spec, item) => !spec.item_when || at(item, spec.item_when.path) === spec.item_when.equals;

/** The part of `value` a page reads, as `spec` (one entry of browser-json-fields.json `files`) declares it. */
export function projectJson(spec, value) {
  if (spec.omit) return Object.fromEntries(Object.entries(value).filter(([key]) => !spec.omit.includes(key)));
  const items = at(value, spec.list);
  if (!Array.isArray(items)) throw new Error(`${spec.file} has no list at ${spec.list.join('.')}.`);
  const kept = items.filter(item => carriedItem(spec, item)).map(item => {
    let one = {};
    for (const path of spec.item_keep) one = keepAt(item, one, path) ?? one;
    return one;
  });
  const out = {};
  // File-level fields shared with a list projection, such as the words its reader draws.
  for (const path of spec.keep ?? []) {
    const field = at(value, path);
    if (field !== undefined) placeAt(out, path, field);
  }
  placeAt(out, spec.list, kept);
  return out;
}

/** The declarations, read from scripts/browser-json-fields.json under `root`. */
export const jsonFieldSpecs = root => JSON.parse(readFileSync(join(root, 'scripts/browser-json-fields.json'), 'utf8')).files;

export function jsonFieldsPlugin(root, home = file => join(root, file)) {
  const declared = jsonFieldSpecs(root);
  const specs = new Map();
  const namespaceOf = spec => spec.id ? `json-fields-${spec.id}` : 'json-fields';
  for (const spec of declared) {
    if (spec.id && !/^[a-z][a-z0-9-]*$/.test(spec.id)) throw new Error(`Invalid JSON projection name: ${spec.id}`);
    const readers = specs.get(spec.file) ?? [];
    if (readers.some(other => other.read_by.some(reader => spec.read_by.includes(reader)))) throw new Error(`Overlapping JSON readers for ${spec.file}`);
    readers.push(spec);
    specs.set(spec.file, readers);
  }
  const fromRoot = path => relative(root, path).split(sep).join('/');
  // A file's name from the build's root, starting ./ or ../, the form a namespaced metafile path names a file by
  // (check-bundle-package-boundaries filePathOfBundleInput).
  const fromBuild = path => (fromRoot(path).startsWith('../') ? fromRoot(path) : `./${fromRoot(path)}`);
  return {
    name: 'json-fields',
    setup(builder) {
      builder.onResolve({ filter: /\.json$/ }, args => {
        if (args.namespace !== 'file' || !args.importer || !args.path.startsWith('.')) return undefined;
        const file = fromRoot(resolve(args.resolveDir, args.path));
        const spec = specs.get(file)?.find(one => one.read_by.includes(fromRoot(args.importer)));
        if (!spec) return undefined;
        // The module is named by its path from the build's root, never its full path: esbuild mixes a namespaced module's
        // path into the content names of the bundles that hold it, so a full path named the folder the pages were built in.
        const at = home(file);
        return { path: fromBuild(at), namespace: namespaceOf(spec), pluginData: { spec, at } };
      });
      for (const namespace of new Set(declared.map(namespaceOf))) builder.onLoad({ filter: /.*/, namespace }, args => ({
        contents: JSON.stringify(projectJson(args.pluginData.spec, JSON.parse(readFileSync(args.pluginData.at, 'utf8')))),
        loader: 'json',
        watchFiles: [args.pluginData.at],
      }));
    },
  };
}
