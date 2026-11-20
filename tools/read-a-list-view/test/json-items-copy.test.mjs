// A list-original row source over one JSON file of items (json-items): every item becomes a row with its keys as fields,
// a second sync changes nothing, a list edit reaches the file and keeps the rest of it, a rule an AI writes under its own
// id becomes an item of the file, and an item removed from the list leaves the file. A made-up kitchen, on a real file.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncStore } from './support/sync-store.mjs';

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
  const root = tempFolder(join(tmpdir(), 'json-items-copy-'));
  await writeFile(join(root, 'kitchen-rules.json'), `${JSON.stringify(RULES, null, 2)}\n`);
  const source = { id: 'rules', source: 'json-items', root, file: 'kitchen-rules.json', at: 'rules', key: 'id', indent: 2, of: '/',
    original: 'list', adopt_own_rows: true, copy_name: '{id}', content: { list_only: ['on'] } };
  const store = syncStore([['list:kitchen-rules', 'list', { label: 'Kitchen rules', row_type: 'kitchen-rule', row_sources: [source] }]]);
  const sync = () => store.sync({ list: 'kitchen-rules' }).then(found => found.sources[0]);
  const file = async () => JSON.parse(await readFile(join(root, 'kitchen-rules.json'), 'utf8'));
  const row = id => store.records().find(record => record.id === id)?.value;
  return { root, store, sync, file, row, done: () => rm(root, { recursive: true, force: true }) };
}

test('every item of the file becomes one row with its keys as fields, and a second sync changes nothing', async () => {
  const k = await kitchen();
  try {
    const first = await k.sync();
    assert.equal(first.pushed, 2);
    const row = k.row(recordOf('no-nuts-in-plain'));
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
    k.store.tick();
    const id = recordOf('no-nuts-in-plain');
    k.store.write(id, TYPE, { ...k.row(id), words: ['walnut', 'pecan', 'almond'], on: 'On' });
    const report = await k.sync();
    assert.equal(report.pulled, 1);
    const file = await k.file();
    assert.deepEqual(file.rules[0].words, ['walnut', 'pecan', 'almond']);
    assert.equal(file.about, RULES.about);
    assert.deepEqual(file.rules[1], RULES.rules[1]);
    // A field outside the copy (a switch any AI sets) stays on the row and never reaches the file.
    assert.equal(k.row(id).on, 'On');
    assert.equal(file.rules[0].on, undefined);
    assert.equal(JSON.parse(k.row(id)['copy.text']).words.length, 3);
  } finally { await k.done(); }
});

test('a rule an AI writes under its own id becomes an item of the file, then the file\'s row', async () => {
  const k = await kitchen();
  try {
    await k.sync();
    k.store.write(`${TYPE}:from-a-phone`, TYPE, { id: 'rest-the-dough', says: 'Rest the dough an hour.', words: ['no rest'] });
    const report = await k.sync();
    assert.equal(report.adopted, 1);
    const file = await k.file();
    assert.deepEqual(file.rules.at(-1), { id: 'rest-the-dough', says: 'Rest the dough an hour.', words: ['no rest'] });
    assert.equal(k.row(`${TYPE}:from-a-phone`), undefined);
    assert.equal(k.row(recordOf('rest-the-dough')).says, 'Rest the dough an hour.');
  } finally { await k.done(); }
});

test('an item changed in the file reaches the list, and an item removed from the list leaves the file', async () => {
  const k = await kitchen();
  try {
    await k.sync();
    const edited = structuredClone(RULES);
    edited.rules[1].says = 'Name the flour and its mill.';
    await writeFile(join(k.root, 'kitchen-rules.json'), `${JSON.stringify(edited, null, 2)}\n`);
    assert.equal((await k.sync()).pushed, 2);
    assert.deepEqual(JSON.parse(k.row(recordOf('no-nuts-in-plain'))['copy.text']), RULES.rules[0]);
    assert.equal(k.row(recordOf('name-the-flour')).says, 'Name the flour and its mill.');
    k.store.tick();
    k.store.write(recordOf('no-nuts-in-plain'), TYPE, null);
    const report = await k.sync();
    assert.equal(report.removed_files, 1);
    assert.deepEqual((await k.file()).rules.map(rule => rule.id), ['name-the-flour']);
  } finally { await k.done(); }
});
