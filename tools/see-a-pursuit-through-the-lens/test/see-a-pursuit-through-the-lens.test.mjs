// The pursuit lens on a made-up lens: the module reads the lens it is handed (useLens, or each call's data), the tool
// answers the lens it is handed and keeps nothing, and its row runs with no records door. Every row here is invented
// for the test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rowOf, answerOf } from '../../../test-helpers/run-a-row.mjs';
import { seeAPursuitThroughTheLens } from '../do-work/see-a-pursuit-through-the-lens.mjs';
import { JOINING_INTERVIEW_FILE, lens, lensForSetup, lensParagraph, useLens } from '../src/pursuit-lens.mjs';

const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const around = { opening: 'Look at what the gardener tends.', parts: [{ id: 'soil', name: 'Soil', about: 'what feeds the plant' }, { id: 'weather', name: 'Weather', about: 'what comes from outside' }], closing: 'Then pick one bed to work.' };
const lensRows = [
  { id: 'roots', part: 'soil', look_for: 'what they water every day', ask_or_do: 'ask which bed they would save first', joining_interview: true },
  { id: 'frost', part: 'weather', look_for: 'the frost they fear', ask_or_do: 'name the date of the last frost' },
];
const madeUp = () => ({ ...around, rows: lensRows });

test('the module reads the lens its caller hands in, once or on each call', () => {
  useLens(madeUp());
  assert.deepEqual(lens, madeUp(), 'the handed-in lens is the module\'s lens');
  assert.equal(lensParagraph(), 'Look at what the gardener tends. Soil: what feeds the plant Weather: what comes from outside Then pick one bed to work.');
  const setup = lensForSetup();
  assert.deepEqual(setup.joining_interview.rows, [{ look_for: 'what they water every day', ask_or_do: 'ask which bed they would save first' }]);
  assert.equal(setup.joining_interview.kept_in, JOINING_INTERVIEW_FILE);
  assert.deepEqual(setup.parts.map(part => [part.name, part.rows.length]), [['Soil', 1], ['Weather', 1]]);
  assert.equal(lensParagraph({ ...madeUp(), opening: 'Another opening.' }).startsWith('Another opening.'), true);
});

test('the tool answers the lens handed in and keeps nothing', () => {
  const both = seeAPursuitThroughTheLens({ lens: madeUp() });
  assert.equal(both.paragraph, lensParagraph(madeUp()));
  assert.deepEqual(both.setup, lensForSetup(madeUp()));
  const handed = seeAPursuitThroughTheLens({ answer: 'paragraph', lens: madeUp() });
  assert.deepEqual(Object.keys(handed), ['paragraph', 'joining_interview_file']);
});

test('refusals say what to hand in', () => {
  assert.throws(() => seeAPursuitThroughTheLens({}), /lens is \{ opening, parts/);
  assert.throws(() => seeAPursuitThroughTheLens({ answer: 'all', lens: madeUp() }), /answer is paragraph/);
  assert.throws(() => seeAPursuitThroughTheLens({ lens: { rows: [] } }), /lens is \{ opening, parts/);
});

test('the row runs with no records door and its answer holds the result', async () => {
  const row = rowOf(rows, 'tool:see-a-pursuit-through-the-lens');
  assert.equal(row.invoke.records, undefined);
  assert.equal(row.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.deepEqual(row.invoke.files.package_files.map(files => files.package), ['see-a-pursuit-through-the-lens', 'workflows']);
  assert.equal(row.uses_tools.includes('trillion-workshop/records-door'), false);
  const made = await answerOf(row, { answer: 'setup', lens: madeUp() });
  assert.equal(made.status, 0, JSON.stringify(made.error));
  assert.deepEqual(made.result.setup.parts.map(part => part.name), ['Soil', 'Weather']);
  const verify = row.verify[0];
  const sample = await answerOf(row, verify.input);
  assert.match(JSON.stringify(sample.result.paragraph), new RegExp(verify.contains));
});
