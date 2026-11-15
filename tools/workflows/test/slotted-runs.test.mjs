// tools/workflows: one slot rule instead of one plug per format. A step that chooses rows (a format, a template, any row
// of any list) hands back which rows; each row names its own workflows in a field of its own, and the step's answer is
// kept only when each of those workflows ran as a sub-run of the step, every step of it kept. The parent recipe names no
// format, and the code below knows no list. Every row and recipe here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerId, runId, slottedRunKey } from '../read-data/step-agents.mjs';
import { slotWorkflows, submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';

const ROW_TYPE = 'record:made-up-formats';
const slotCheck = { kind: 'slotted-runs', path: ['this', 'chosen'], row: 'row', type: 'type', slot: 'workflows', says: 'Each chosen row ran its own workflows' };
const chooseStep = { id: 'choose', title: 'Choose a format', do: 'Choose the format rows this piece uses.', submit: { type: 'object', required: ['chosen'], properties: { chosen: { type: 'array' } } }, checks: [slotCheck] };
const parentRun = 'ai-job:workflow:made-up-piece:k1';
const subSteps = [{ id: 'draft', title: 'Draft', do: 'Draft it.', submit: { type: 'object' } }, { id: 'cut', title: 'Cut', do: 'Cut it.', submit: { type: 'object' } }];

function memoryDoor(rows = {}) {
  const held = new Map([[parentRun, { value: { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-piece', label: 'Made-up piece', job: [chooseStep], input: {} } }]]);
  for (const [id, value] of Object.entries(rows)) held.set(id, { value });
  return {
    held,
    read: async (_type, id) => held.get(id)?.value ?? null,
    async *list() {},
    write: async records => { for (const record of records) held.set(record.id, record); },
  };
}
const submit = (door, run, step, answer, key = 's1') => submitARecipeStep({ input: { run, step, answer, ...(run === parentRun ? { rows_of: ROW_TYPE } : {}) }, task: { request_key: key } }, { door });
const chosen = (...rows) => ({ chosen: rows.map(row => ({ row, type: ROW_TYPE })) });
// The sub-run a row's workflow gets in this step, written the way start-a-recipe-run writes any run.
const startSub = (door, workflow, row) => {
  const id = runId(workflow, slottedRunKey(parentRun, 'choose', row));
  door.held.set(id, { value: { kind: 'ai-job', status: 'waiting', row: workflow, label: workflow, job: subSteps, input: { row } } });
  return id;
};

test('a chosen row that holds no workflow fails and names the row', async () => {
  const door = memoryDoor({ 'made-up-map-short': { title: 'Map short' } });
  await assert.rejects(submit(door, parentRun, 'choose', chosen('made-up-map-short')), /made-up-map-short: holds no workflow in workflows/);
  assert.equal(door.held.has(answerId(parentRun, 'choose')), false);
});

test('a chosen row that is not there fails naming it', async () => {
  const door = memoryDoor();
  await assert.rejects(submit(door, parentRun, 'choose', chosen('made-up-nothing')), /made-up-nothing: there is no record:made-up-formats row/);
});

test('the step is kept only once each workflow of each chosen row has run as its sub-run with every step kept', async () => {
  const door = memoryDoor({
    'made-up-map-short': { workflows: '["made-up-draw-the-map","workflow:made-up-voice-it"]' },
    'made-up-quote-card': { workflows: 'workflow:made-up-set-the-quote' },
  });
  const answer = chosen('made-up-map-short', 'made-up-quote-card');
  // Nothing has run: every sub-run is named, by the id the AI starts it under.
  const none = await submit(door, parentRun, 'choose', answer).catch(error => error.message);
  for (const [workflow, row] of [['workflow:made-up-draw-the-map', 'made-up-map-short'], ['workflow:made-up-voice-it', 'made-up-map-short'], ['workflow:made-up-set-the-quote', 'made-up-quote-card']])
    assert.ok(none.includes(`${row}: ${runId(workflow, slottedRunKey(parentRun, 'choose', row))} (not finished)`), `${workflow} in ${none}`);
  // Started, and one step of one sub-run kept: still not finished.
  const runs = [startSub(door, 'workflow:made-up-draw-the-map', 'made-up-map-short'), startSub(door, 'workflow:made-up-voice-it', 'made-up-map-short'), startSub(door, 'workflow:made-up-set-the-quote', 'made-up-quote-card')];
  await submit(door, runs[0], 'draft', { text: 'made up' });
  await assert.rejects(submit(door, parentRun, 'choose', answer), /not finished/);
  for (const run of runs) for (const step of subSteps) if (!door.held.has(answerId(run, step.id))) await submit(door, run, step.id, { text: 'made up' });
  const kept = await submit(door, parentRun, 'choose', answer);
  assert.equal(kept.status, 'kept');
  assert.deepEqual(kept.checks.map(check => check.kind), ['slotted-runs']);
});

test('a finished run of the same workflow under another key does not stand for this step\'s sub-run', async () => {
  const door = memoryDoor({ 'made-up-quote-card': { workflows: ['workflow:made-up-set-the-quote'] } });
  const elsewhere = runId('workflow:made-up-set-the-quote', 'some-other-run');
  door.held.set(elsewhere, { value: { kind: 'ai-job', status: 'waiting', row: 'workflow:made-up-set-the-quote', job: subSteps, input: {} } });
  for (const step of subSteps) await submit(door, elsewhere, step.id, { text: 'made up' });
  await assert.rejects(submit(door, parentRun, 'choose', chosen('made-up-quote-card')), /not finished/);
});

test('an answer cannot bring its own catalog, and a slot holding something other than workflow ids fails', async () => {
  const door = memoryDoor({ 'made-up-odd': { workflows: [7] } });
  await assert.rejects(submitARecipeStep({ input: { run: parentRun, step: 'choose', answer: chosen('made-up-odd'), catalogs: {} }, task: { request_key: 'k' } }, { door }), /is not taken/);
  await assert.rejects(submit(door, parentRun, 'choose', chosen('made-up-odd')), /made-up-odd: its workflows is not a workflow id or a list of them/);
  assert.deepEqual(slotWorkflows(['a', 'workflow:a', 'b']), ['workflow:a', 'workflow:b']);
  assert.deepEqual(slotWorkflows(''), []);
  assert.equal(slotWorkflows('[not json'), null);
});

test('the rows are read only from the list the caller named, and the plain submit names the tool to use', async () => {
  const door = memoryDoor({ 'made-up-map-short': { workflows: ['workflow:made-up-voice-it'] } });
  const plain = input => submitARecipeStep({ input, task: { request_key: 'p' } }, { door });
  await assert.rejects(plain({ run: parentRun, step: 'choose', answer: chosen('made-up-map-short') }), /hand the step in with tool:submit-a-step-that-slots-rows and rows_of record:made-up-formats/);
  await assert.rejects(plain({ run: parentRun, step: 'choose', answer: chosen('made-up-map-short'), rows_of: 'record:made-up-other' }), /is a record:made-up-formats row/);
  await assert.rejects(plain({ run: parentRun, step: 'choose', answer: chosen('made-up-map-short'), rows_of: 'ai-job' }), /rows_of must name the list row type/);
});

test('the recipe validator takes the check and refuses one that names no slot field', () => {
  const recipeOf = checks => ({ kind: 'workflow-recipe', id: 'workflow:made-up-piece', label: 'Made-up piece', job: 'Make a made-up piece.', steps: [{ ...chooseStep, checks }] });
  assert.deepEqual(recipeProblems(recipeOf([slotCheck])), []);
  const { slot, ...noSlot } = slotCheck;
  assert.match(recipeProblems(recipeOf([noSlot])).join('\n'), /slot must name the row's own field/);
});
