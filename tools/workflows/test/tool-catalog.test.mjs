// tools/workflows: published/tools.json is exactly what the Workshop's tool rows make, holds one row per tool and no
// schema or run detail, and its key is the content identity of its fields and rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogDocument, catalogText, toolCatalog } from '../read-data/tool-catalog.mjs';
import { workshopRows } from '../read-data/workshop-tool-ids.mjs';

const tools = join(dirname(fileURLToPath(import.meta.resolve('trillion-workshop/package.json'))), 'tools');

function toolsFolder(folders) {
  const root = join(mkdtempSync(join(tmpdir(), 'tool-catalog-')), 'tools');
  mkdirSync(root, { recursive: true });
  for (const [name, records] of Object.entries(folders)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'tool-rows.json'), JSON.stringify({ records: records.map(payload => ({ payload })) }));
  }
  return root;
}

const tool = (id, extra = {}) => ({ kind: 'ai-tool-descriptor', id: `tool:${id}`, label: `Label of ${id}`, job: `Job of ${id}`, status: 'active', maker: `maker:${id}`, licence_class: 'licence:maker-own', placements: ['placement:small-container'], input_schema: { type: 'object' }, output_schema: { type: 'object' }, invoke: { kind: 'container' }, provenance: { source: 'somewhere' }, ...extra });

test('published/tools.json is exactly what the tool rows make, and holds one row per tool', () => {
  assert.equal(readFileSync(new URL('../published/tools.json', import.meta.url), 'utf8'), catalogText(tools));
  const ids = workshopRows(tools).filter(({ payload }) => payload.kind === 'ai-tool-descriptor').map(({ payload }) => payload.id);
  const rows = JSON.parse(readFileSync(new URL('../published/tools.json', import.meta.url), 'utf8')).rows;
  assert.equal(rows.length, ids.length);
  assert.deepEqual(rows.map(row => row.id), [...ids].sort());
});

test('a row holds flat facts only: no schema, no way of running, no provenance, and flags for what a person can use', () => {
  const root = toolsFolder({
    bakery: [tool('bake', { read_only: true, keeps_records: true, listed_on: '2026-10-30T12:00:00Z' }), { kind: 'maker', id: 'maker:bake' }, tool('sell', { billing: { per: 'sale' }, status: 'active' })],
    zoo: [tool('feed')],
  });
  const { rows } = toolCatalog(root);
  assert.deepEqual(rows.map(row => row.id), ['tool:bake', 'tool:feed', 'tool:sell']);
  assert.deepEqual(rows[0].values, { title: 'Label of bake', job: 'Job of bake', status: 'active', maker: 'maker:bake', licence_class: 'licence:maker-own', placements: ['placement:small-container'], listed_on: '2026-10-30T12:00:00Z', folder: 'bakery', flags: ['read-only', 'keeps-records'] });
  assert.deepEqual(rows[2].values.flags, ['priced']);
  assert.ok(!('flags' in rows[1].values), 'a tool with no flags has none');
  for (const row of rows) for (const name of ['input_schema', 'output_schema', 'invoke', 'provenance']) assert.ok(!(name in row.values));
});

test('rows a tool-row-source lists belong to the folder that lists them', () => {
  const root = toolsFolder({
    'from-a-repository': [{ kind: 'tool-row-source', id: 'source:repos', list: { records: { package: 'from-a-repository', kind: 'ai-tool-descriptor', file: 'listed.json' } } }],
  });
  writeFileSync(join(root, 'from-a-repository', 'listed.json'), JSON.stringify({ things: [{ payload: tool('github:owner-repo') }] }));
  assert.deepEqual(toolCatalog(root).rows.map(row => [row.id, row.values.folder]), [['tool:github:owner-repo', 'from-a-repository']]);
});

test('the key is the content identity of the canonical fields and rows', () => {
  const empty = catalogDocument(toolsFolder({}));
  assert.equal(empty.schema, 'list-view-file/v1');
  assert.equal(empty.source.blake3, '1f:d1b1d2c19093ed68deca7ee82393cf00962212c0918b6c7197239ccda6868fc1');
  const folders = { a: [tool('one')], b: [tool('two')] };
  assert.equal(catalogDocument(toolsFolder(folders)).source.blake3, catalogDocument(toolsFolder({ b: folders.b, a: folders.a })).source.blake3, 'the order the folders are read in does not change the key');
});
