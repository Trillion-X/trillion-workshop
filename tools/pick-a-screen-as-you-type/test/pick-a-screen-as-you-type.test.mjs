// tools/pick-a-screen-as-you-type/test/pick-a-screen-as-you-type.test.mjs: the tool's run over made-up input, and each row run the way the runner runs it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rowOf, runRow } from '../../records-door/test/run-row.mjs';
import { select } from '../../../test-helpers/run-a-row.mjs';
import { pickAScreenForWords, fillInputsFromWords } from '../do-work/pick-a-screen-as-you-type.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

const rowsHere = [{ id: 'tool:focus-timer', label: 'Focus timer', description: 'Counts down a focus session' }, { id: 'sample.calendar', label: 'Calendar', description: 'Days and events' }];

test('typed words pick a screen from the catalog handed in, and a challenger needs two wins to replace it', () => {
  const first = pickAScreenForWords({ words: 'calendar', rows: rowsHere });
  assert.equal(first.memory.shown.entry.screen, 'sample.calendar');
  const kept = pickAScreenForWords({ words: 'my standup', rows: rowsHere, asks: [{ id: 'k1', words: 'my standup', screen: 'sample.calendar', input: { view: 'day' } }] });
  assert.equal(kept.picks[0].entry.key, 'kept:k1');
  assert.equal(kept.picks[0].score, 1);
});

test('a screen\'s inputs are filled from the words with no model, at the device\'s time', () => {
  assert.deepEqual(fillInputsFromWords({ schema: { properties: { seconds: { type: 'number' } } }, words: 'timer 25 min' }).values, { seconds: 1500 });
  const now = new Date(2026, 9, 20, 14, 5).toISOString();
  assert.deepEqual(fillInputsFromWords({ schema: { properties: { day: { type: 'string', format: 'date' } } }, words: 'in 3 days', now }).values, { day: '2026-10-23' });
  assert.throws(() => fillInputsFromWords({ words: 'x' }), /schema is the screen/);
});

test('tool:pick-a-screen-for-typed-words runs as the container runner runs it, on its own sample', async () => {
  const row = rowOf(rows, 'tool:pick-a-screen-for-typed-words');
  const ran = await runRow(row, row.verify[0].input);
  assert.equal(ran.status, 0, JSON.stringify(ran.error));
  assert.match(JSON.stringify(select(ran, row.result_selector + row.verify[0].output_selector.slice(1))), new RegExp(row.verify[0].contains));
});

test('tool:fill-screen-inputs-from-words runs as the container runner runs it, on its own sample', async () => {
  const row = rowOf(rows, 'tool:fill-screen-inputs-from-words');
  const ran = await runRow(row, row.verify[0].input);
  assert.equal(ran.status, 0, JSON.stringify(ran.error));
  assert.match(JSON.stringify(select(ran, row.result_selector + row.verify[0].output_selector.slice(1))), new RegExp(row.verify[0].contains));
});
