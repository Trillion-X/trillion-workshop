// The pursuit lens on a made-up lens: the module reads the lens it is handed (useLens, or each call's data), the tool
// reads it from the person's lists through their records door, and the row runs with exactly its rights. Every row
// here is invented for the test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rowOf, runRow } from '../../records-door/test/run-row.mjs';
import { seeAPursuitThroughTheLens } from '../do-work/see-a-pursuit-through-the-lens.mjs';
import { JOINING_INTERVIEW_FILE, lens, lensForSetup, lensParagraph, useLens } from '../src/pursuit-lens.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const around = { opening: 'Look at what the gardener tends.', parts: [{ id: 'soil', name: 'Soil', about: 'what feeds the plant' }, { id: 'weather', name: 'Weather', about: 'what comes from outside' }], closing: 'Then pick one bed to work.' };
const lensRows = [
  { id: 'roots', part: 'soil', look_for: 'what they water every day', ask_or_do: 'ask which bed they would save first', joining_interview: true },
  { id: 'frost', part: 'weather', look_for: 'the frost they fear', ask_or_do: 'name the date of the last frost' },
];
const madeUp = () => ({ ...around, rows: lensRows });

// The person's records as the lists door reads them: the lens list, its rows, and the row around them.
const records = () => [
  { id: 'list:pursuit-lens', type: 'list', value: { label: 'Pursuit lens', row_type: 'pursuit-lens', title_field: 'look_for', indexes: [] } },
  ...lensRows.map(({ id, ...values }) => ({ id: `record:pursuit-lens:${id}`, type: 'record:pursuit-lens', value: values })),
  { id: 'record:content-setting:pursuit-lens', type: 'record:content-setting', value: around },
];
function memoryDoor(list = records()) {
  const kept = new Map(list.map(record => [record.id, record]));
  return {
    async read(type, id) { const held = kept.get(id); return held?.type === type ? structuredClone(held.value) : null; },
    async *list({ type }) { for (const id of [...kept.keys()].filter(id => kept.get(id).type === type).sort().reverse()) yield structuredClone(kept.get(id)); },
    async write() { throw new Error('this tool writes nothing'); },
  };
}

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

test('the tool reads the lens from the person\'s lists, or takes it handed in', async () => {
  const fromLists = await seeAPursuitThroughTheLens({}, { door: memoryDoor() });
  assert.equal(fromLists.paragraph, lensParagraph(madeUp()));
  assert.deepEqual(fromLists.setup, lensForSetup({ ...madeUp(), rows: [...lensRows].sort((a, b) => a.id.localeCompare(b.id)) }));
  const handed = await seeAPursuitThroughTheLens({ answer: 'paragraph', lens: madeUp() });
  assert.deepEqual(Object.keys(handed), ['paragraph', 'joining_interview_file']);
});

test('refusals say what is missing and what to hand in', async () => {
  await assert.rejects(seeAPursuitThroughTheLens({}, { door: memoryDoor([]) }), /no pursuit lens in your lists yet: the list pursuit-lens holds no rows/);
  await assert.rejects(seeAPursuitThroughTheLens({}, { door: memoryDoor(records().slice(0, 3)) }), /the row pursuit-lens of list content-settings, which holds the lens's opening, parts and closing, is missing/);
  await assert.rejects(seeAPursuitThroughTheLens({ answer: 'all' }), /answer is paragraph/);
  await assert.rejects(seeAPursuitThroughTheLens({ lens: { rows: [] } }), /lens is \{ opening, parts/);
});

test('the row runs through the records door with exactly its rights', async () => {
  const row = rowOf(rows, 'tool:see-a-pursuit-through-the-lens');
  const made = await runRow(row, { answer: 'setup' }, { records: records() });
  assert.equal(made.status, 0, JSON.stringify(made.error));
  assert.deepEqual(made.result.setup.parts.map(part => part.name), ['Soil', 'Weather']);
  const verify = row.verify[0];
  const sample = await runRow(row, verify.input, { records: [] });
  assert.match(JSON.stringify(sample.result.paragraph), new RegExp(verify.contains));
});
