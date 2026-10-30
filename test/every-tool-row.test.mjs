// Every tool folder's rows, checked the way Trillion reads them before it offers a tool: each tools/<name>/tool-rows.json
// is { records: [{ payload }] }; a row's files (invoke.files.package_files) name a tool folder here and paths that are
// in it; a tool-row-source's list.records names a records file (or a folder of them) here holding rows of its kind; every licence class a
// row names is in licence-classes.json; no two rows share an id; and a folder with no row is a library some row
// packs. Nothing here names a tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tools = resolve(root, 'tools');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const folders = readdirSync(tools, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const classes = new Set(json(resolve(root, 'licence-classes.json')).records.map(record => record.payload.id));

// The rows each folder offers: its tool-rows.json, plus the rows a tool-row-source there lists from a records file.
function rowsOf(folder) {
  const file = join(tools, folder, 'tool-rows.json');
  if (!existsSync(file)) return [];
  const kept = json(file).records;
  assert.ok(Array.isArray(kept), `${folder}/tool-rows.json has a records list`);
  return kept.flatMap(({ payload }) => {
    assert.ok(payload?.kind && payload?.id, `${folder}/tool-rows.json: every record has a payload with kind and id`);
    if (payload.kind !== 'tool-row-source' || !payload.list?.records) return [{ folder, payload }];
    const { package: name, kind, file: records = 'records.json' } = payload.list.records;
    const path = join(tools, name, records);
    assert.ok(existsSync(path), `${payload.id} lists ${name}/${records}, which is here`);
    // A file holds its rows; a folder holds files that each hold rows. Either way a row is { payload } in things or records.
    const files = statSync(path).isDirectory()
      ? readdirSync(path).filter(entry => entry.endsWith('.json')).map(entry => join(path, entry))
      : [path];
    const listed = files.flatMap(file => { const kept = json(file); return kept.things ?? kept.records ?? []; })
      .filter(thing => thing?.payload?.kind === kind);
    assert.ok(listed.length, `${payload.id}: ${name}/${records} holds rows of kind ${kind}`);
    return [{ folder, payload }, ...listed.map(thing => ({ folder: name, payload: thing.payload }))];
  });
}

const rows = folders.flatMap(rowsOf);

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
