// tools/cross-techniques-with-a-goal: rows that say the same thing share one group, by the vocabulary's admission
// rule, with hand-made vectors; rows in the uncertain band are linked as related, never merged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unit } from '../do-work/meaning.mjs';
import { groupRows, groupRowsByMeaning, libraryRows, pairsByBand } from '../do-work/group-rows-by-meaning.mjs';

const lines = { reuse_at: 0.9, new_below: 0.6 };
const rows = [
  { id: 'P-1', source: 'registry', text: 'Water the soil before you plant.', vector: unit([1, 0, 0]) },
  { id: 'a@5#1', source: 'channel a', text: 'Soak the bed before planting anything.', vector: unit([1, 0.1, 0]) },
  { id: 'b@9#1', source: 'channel b', text: 'Water the soil before you plant.', vector: unit([0.2, 1, 0]) },
  { id: 'b@30#2', source: 'channel b', text: 'Plant one bed and look at it daily.', vector: unit([0.8, 0.6, 0]) },
  { id: 'c@2#1', source: 'channel c', text: 'Pull weeds before they seed.', vector: unit([0, 0, 1]) },
];

test('the same words or a meaning at reuse_at join the first row\'s group; the band is related, not merged', async () => {
  const { rows: grouped } = await groupRows(rows, lines);
  const by = Object.fromEntries(grouped.map(row => [row.id, row]));
  assert.deepEqual([by['P-1'].group, by['P-1'].how], ['P-1', 'new']);
  assert.deepEqual([by['a@5#1'].group, by['a@5#1'].how], ['P-1', 'same-meaning']);
  assert.ok(by['a@5#1'].closeness >= 0.9);
  assert.deepEqual([by['b@9#1'].group, by['b@9#1'].how], ['P-1', 'same-words'], 'the same words join whatever the vector');
  assert.deepEqual([by['b@30#2'].group, by['b@30#2'].how], ['b@30#2', 'new']);
  assert.deepEqual(by['b@30#2'].related.map(item => item.id), ['P-1'], 'a row in the band names the group it is close to');
  assert.ok(by['b@30#2'].related[0].closeness < 0.9 && by['b@30#2'].related[0].closeness >= 0.6);
  assert.deepEqual([by['c@2#1'].group, by['c@2#1'].related], ['c@2#1', []]);
});

test('folding the same rows in the same order gives the same groups', async () => {
  assert.deepEqual(await groupRows(rows, lines), await groupRows(rows, lines));
});

test('pairs come from different sources only, sorted into closeness bands', () => {
  const bands = pairsByBand(rows, [[0.9, 1.01], [0.6, 0.9]], 5);
  const all = bands.flatMap(band => band.pairs);
  assert.ok(!all.some(pair => [pair.one.id, pair.other.id].sort().join() === ['b@30#2', 'b@9#1'].sort().join()), 'two rows of one source are never a pair');
  assert.ok(bands[0].pairs.every(pair => pair.closeness >= 0.9));
});

test('a library row\'s words are its named fields joined; a row with none is left out', () => {
  const folder = mkdtempSync(join(tmpdir(), 'group-rows-'));
  const file = join(folder, 'made-up.jsonl');
  writeFileSync(file, `${JSON.stringify({ id: 1, statement: 'Plant early.', note: 'In spring.' })}\n${JSON.stringify({ id: 2, kind: 'tactic' })}\n`);
  assert.deepEqual(libraryRows([{ file, text: ['statement', 'note'], label: 'made up' }]), [{ id: '1', source: 'made up', text: 'Plant early. | In spring.' }]);
});

test('grouping with a meaning other than the one the row lines were measured with is refused', async () => {
  const meaning = { url: 'http://127.0.0.1:9/v1', model: 'another-model', dims: 3, forms: { query: '{text}', document: '{text}' } };
  await assert.rejects(() => groupRowsByMeaning({ step: 'group', sources: [], meaning }), /measured row lines are for/);
});

test('the groups file keys each row by its id, so a list builder can look it up', async () => {
  const measured = JSON.parse(readFileSync(fileURLToPath(new URL('../do-work/technique-conventions.json', import.meta.url)), 'utf8')).row_lines.meaning;
  const vector = { 'title: none | text: Water the soil first.': [1, 0], 'title: none | text: Soak the bed first.': [0.98, 0.2], 'title: none | text: Pull weeds early.': [0, 1] };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const { input } = JSON.parse(body);
      response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: [...vector[text], ...Array(measured.dims - 2).fill(0)] })) }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const folder = mkdtempSync(join(tmpdir(), 'group-file-'));
    const file = join(folder, 'made-up.jsonl');
    writeFileSync(file, ['Water the soil first.', 'Soak the bed first.', 'Pull weeds early.'].map((statement, index) => JSON.stringify({ id: `r${index}`, statement })).join('\n'));
    const groupsFile = join(folder, 'groups.json');
    await groupRowsByMeaning({ step: 'group', sources: [{ file, text: ['statement'] }], meaning: { ...measured, url: `http://127.0.0.1:${server.address().port}/v1` }, groups_file: groupsFile });
    const { rows } = JSON.parse(readFileSync(groupsFile, 'utf8'));
    assert.deepEqual(Object.keys(rows), ['r0', 'r1', 'r2']);
    assert.deepEqual([rows.r1.group, rows.r1.how], ['r0', 'same-meaning']);
    assert.deepEqual([rows.r2.group, rows.r2.how], ['r2', 'new']);
  } finally {
    server.close();
  }
});
