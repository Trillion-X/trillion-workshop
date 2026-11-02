// A list that is the original and ONE JSON file holding many of its rows (the json-items row source,
// documents-as-list-rows read-data/json-items.mjs), on a made-up bakery's kitchen rules: the rules file a kitchen
// program reads at start, and a list any of the bakery's AIs writes to. The door is the real one (door.mjs) over HTTP to
// a stand-in records door that keeps every version of a record with its time; the json-items tools run on this computer
// through local_tools over a real file. list-copy.mjs settles it exactly as it settles a folder of documents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshRowSources } from '../read-data/list-view.mjs';
import { openDoor } from '../read-data/door.mjs';

const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' };
const TYPE = 'record:kitchen-rule';
const recordOf = id => `${TYPE}:rules~${encodeURIComponent(`/${id}`)}`;
const RULES = {
  about: 'The kitchen rules every order is checked against.',
  rules: [
    { id: 'no-nuts-in-plain', says: 'A plain loaf holds no nuts.', words: ['walnut', 'pecan'] },
    { id: 'name-the-flour', says: 'Name the flour.', words: ['some flour'] },
  ],
};

async function kitchen() {
  const root = await mkdtemp(join(tmpdir(), 'json-items-copy-'));
  await writeFile(join(root, 'kitchen-rules.json'), `${JSON.stringify(RULES, null, 2)}\n`);
  const source = { id: 'rules', source: 'json-items', root, file: 'kitchen-rules.json', at: 'rules', key: 'id', indent: 2, of: '/',
    original: 'list', adopt_own_rows: true, copy_name: '{id}', content: { list_only: ['on'] } };
  const records = new Map([['list:kitchen-rules', { label: 'Kitchen rules', row_type: 'kitchen-rule', row_sources: [source] }]]);
  const versions = new Map();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const keep = (id, value) => {
    if (value === null) records.delete(id); else records.set(id, value);
    versions.set(id, [{ value, deleted: value === null, at: new Date(clock).toISOString() }, ...(versions.get(id) ?? [])]);
  };
  const answer = ({ method, input }) => {
    if (method === 'records:read') return { id: input.id, type: input.type, value: records.get(input.id) ?? null };
    if (method === 'records:history') return { versions: (versions.get(input.id) ?? []).slice(0, input.limit) };
    if (method === 'records:write') {
      for (const row of input.records) keep(row.id, row.value);
      return { changed: true, write_count: input.records.length };
    }
    const prefix = input.prefix ?? `${input.type}:`;
    const ids = [...records.keys()].filter(id => id.startsWith(`${input.type}:`) && id.startsWith(prefix) && (!input.after || id > input.after)).sort();
    const shown = ids.slice(0, input.limit);
    return { records: shown.map(id => ({ id, type: input.type, value: records.get(id) })), next: shown.length < ids.length ? shown.at(-1) : null };
  };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { structuredContent: answer(call.params.arguments) } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const door = await openDoor({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'made-up' } },
    records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list', write_method: 'records:write', history_method: 'records:history' },
    tools: { address: '@workshop-tools', run_method: 'tools:run' },
    local_tools: {
      'tool:read-json-items-as-list-rows': { module: 'documents-as-list-rows/read-data/json-items.mjs', export: 'readJsonItemRows', input: { root } },
      'tool:change-a-json-item-row': { module: 'documents-as-list-rows/read-data/json-items.mjs', export: 'changeJsonItemRows', input: { root } },
    } }, { keyOf: async () => 'made-up-key' });
  const sync = () => refreshRowSources({ names: NAMES, list: 'kitchen-rules' }, door).then(found => found.sources[0]);
  const file = async () => JSON.parse(await readFile(join(root, 'kitchen-rules.json'), 'utf8'));
  return { root, records, keep, sync, file, tick: () => { clock += 60_000; },
    done: async () => { server.close(); await rm(root, { recursive: true, force: true }); } };
}

test('every item of the file becomes one row with its keys as fields, and a second sync changes nothing', async () => {
  const k = await kitchen();
  try {
    const first = await k.sync();
    assert.equal(first.pushed, 2);
    const row = k.records.get(recordOf('no-nuts-in-plain'));
    assert.equal(row.says, 'A plain loaf holds no nuts.');
    assert.deepEqual(row.words, ['walnut', 'pecan']);
    assert.deepEqual(JSON.parse(row['copy.text']), RULES.rules[0]);
    const again = await k.sync();
    assert.equal(again.unchanged, 2);
    assert.deepEqual(await k.file(), RULES);
  } finally { await k.done(); }
});

test('a field changed in the list reaches the file, and the rest of the file is kept', async () => {
  const k = await kitchen();
  try {
    await k.sync();
    k.tick();
    const id = recordOf('no-nuts-in-plain');
    k.keep(id, { ...k.records.get(id), words: ['walnut', 'pecan', 'almond'], on: 'On' });
    const report = await k.sync();
    assert.equal(report.pulled, 1);
    const file = await k.file();
    assert.deepEqual(file.rules[0].words, ['walnut', 'pecan', 'almond']);
    assert.equal(file.about, RULES.about);
    assert.deepEqual(file.rules[1], RULES.rules[1]);
    // A field outside the copy (a switch any AI sets) stays on the row and never reaches the file.
    assert.equal(k.records.get(id).on, 'On');
    assert.equal(file.rules[0].on, undefined);
    assert.equal(JSON.parse(k.records.get(id)['copy.text']).words.length, 3);
  } finally { await k.done(); }
});

test('a rule an AI writes under its own id becomes an item of the file, then the file\'s row', async () => {
  const k = await kitchen();
  try {
    await k.sync();
    k.keep(`${TYPE}:from-a-phone`, { id: 'rest-the-dough', says: 'Rest the dough an hour.', words: ['no rest'] });
    const report = await k.sync();
    assert.equal(report.adopted, 1);
    const file = await k.file();
    assert.deepEqual(file.rules.at(-1), { id: 'rest-the-dough', says: 'Rest the dough an hour.', words: ['no rest'] });
    assert.equal(k.records.has(`${TYPE}:from-a-phone`), false);
    assert.equal(k.records.get(recordOf('rest-the-dough')).says, 'Rest the dough an hour.');
  } finally { await k.done(); }
});

test('an item changed in the file reaches the list, and an item removed from the list leaves the file', async () => {
  const k = await kitchen();
  try {
    await k.sync();
    const edited = structuredClone(RULES);
    edited.rules[1].says = 'Name the flour and its mill.';
    await writeFile(join(k.root, 'kitchen-rules.json'), `${JSON.stringify(edited, null, 2)}\n`);
    // Both rows are written: the file's change time is every item's file.mtime, and only the edited item's text changed.
    assert.equal((await k.sync()).pushed, 2);
    assert.deepEqual(JSON.parse(k.records.get(recordOf('no-nuts-in-plain'))['copy.text']), RULES.rules[0]);
    assert.equal(k.records.get(recordOf('name-the-flour')).says, 'Name the flour and its mill.');
    k.tick();
    k.keep(recordOf('no-nuts-in-plain'), null);
    const report = await k.sync();
    assert.equal(report.removed_files, 1);
    assert.deepEqual((await k.file()).rules.map(rule => rule.id), ['name-the-flour']);
  } finally { await k.done(); }
});
