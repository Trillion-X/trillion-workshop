// The six tools the old Workshop gave Recently Deleted and Archived (records/old-recently-deleted-tool-descriptors.json, the old
// repository at 5dc302be37) against the rows that answer them now, and the one this tool runs over the person's setting:keep_for
// (tool:set-deleted-files-keep-for), run the way the container runs a row (test-helpers/run-a-row.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const old = read('../records/old-recently-deleted-tool-descriptors.json').records.map(row => row.payload.id);
const here = read('../what-this-tool-does-and-how-to-run-it.json').records.map(row => row.payload);
const sibling = read('../../recently-deleted/what-this-tool-does-and-how-to-run-it.json').records.map(row => row.payload);
const row = here.find(item => item.id === 'tool:set-deleted-files-keep-for');
const keepFor = value => ({ id: 'setting:keep_for', type: 'setting', value });

test('the six old tool ids are known, and the two that need only the person\'s own setting have a running row', () => {
  assert.deepEqual(old.sort(), ['tool:archive-files', 'tool:delete-files', 'tool:put-back-files', 'tool:read-deleted-files-keep-for', 'tool:recently-deleted', 'tool:set-deleted-files-keep-for']);
  assert.ok(sibling.some(item => item.id === 'tool:read-deleted-files-keep-for'));
  assert.ok(row);
});

test('set keep-for changes a state\'s days at once, keeps the other states and the setting\'s other fields, and hands back the setting to keep', async () => {
  const sample = { records: [keepFor({ value: { archived: 90 }, label: 'mine' })] };
  const run = await runRow(row, { after_days: { deleted: 7 } }, sample);
  assert.equal(run.code, 0, run.stderr);
  const { result } = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result.states.map(state => [state.id, state.after_days, state.default_after_days]), [['deleted', 7, 30], ['archived', 90, 30]]);
  assert.deepEqual(result.keep, [keepFor({ value: { archived: 90, deleted: 7 }, label: 'mine' })]);
});

test('null keeps until put back; with no setting yet one is made; a state left out keeps its days', async () => {
  const none = JSON.parse((await runRow(row, { after_days: { archived: null } }, { records: [] })).stdout.trim().split('\n').at(-1)).result;
  assert.deepEqual(none.states.map(state => state.after_days), [30, null]);
  assert.deepEqual(none.keep, [keepFor({ value: { archived: null } })]);
  const same = JSON.parse((await runRow(row, { after_days: {} }, { records: [keepFor({ value: { deleted: 5 } })] })).stdout.trim().split('\n').at(-1)).result;
  assert.equal(same.states[0].after_days, 5);
  assert.equal(same.keep, undefined);
});

test('days outside 0 to 36500, fractions and unknown states are refused with words and nothing is written', async () => {
  for (const after_days of [{ deleted: -1 }, { deleted: 36501 }, { deleted: 1.5 }, { nowhere: 3 }]) {
    const run = await runRow(row, { after_days }, { records: [] });
    assert.equal(run.code, 1);
    assert.match(JSON.parse(run.stdout.trim().split('\n').at(-1)).error, /allowed day count|declared archive state/);
  }
});
