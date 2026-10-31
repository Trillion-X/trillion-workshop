// The rows every tool folder offers, read the way Trillion reads them before it offers a tool: each
// tools/<name>/tool-rows.json is { records: [{ payload }] }, and a tool-row-source's list.records names a records file (or
// a folder of them) holding rows of its kind. Read by test/every-tool-row.test.mjs and test/lockfile-licences.test.mjs.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const tools = resolve(root, 'tools');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const folders = readdirSync(tools, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);

// The rows each folder offers: its tool-rows.json, plus the rows a tool-row-source there lists from a records file.
export function rowsOf(folder) {
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

export const rows = () => folders.flatMap(rowsOf);
