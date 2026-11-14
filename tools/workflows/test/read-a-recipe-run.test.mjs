// tools/workflows: where a recipe run stands is read from the run's own rows, the job start-a-recipe-run writes and the
// answers submit-a-recipe-step keeps, and nothing is written. Every recipe and step name here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readARecipeRun, runId } from '../read-data/read-a-recipe-run.mjs';
import { startARecipeRun } from '../read-data/start-a-recipe-run.mjs';
import { submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';

const recipe = 'workflow:made-up-two-steps';
const steps = [
  { id: 'look', title: 'Look', do: 'Look.', submit: { type: 'object' }, checks: [] },
  { id: 'say', title: 'Say', do: 'Say.', submit: { type: 'object' }, checks: [] },
];

function door() {
  const held = new Map();
  const writes = [];
  const value = id => held.get(id)?.value ?? null;
  return {
    held, writes,
    read: async (_kind, id) => value(id),
    async *list() {},
    write: async records => { writes.push(...records); for (const record of records) held.set(record.id, record); },
  };
}
const startHeld = (d, key) => d.held.set(runId(recipe, key), { id: runId(recipe, key), value: { kind: 'ai-job', status: 'waiting', row: recipe, label: 'Made up', job: steps, input: {} } });

test('a run never started reads as not there, with no steps and nothing written', async () => {
  const d = door();
  assert.deepEqual(await readARecipeRun({ recipe, request_key: 'k1' }, { door: d }),
    { run: 'ai-job:workflow:made-up-two-steps:k1', exists: false, status: null, label: null, input: null, steps: [], finished: false });
  assert.equal(d.writes.length, 0);
});

test('a started run reads each step kept only once its checked answer is kept, and finished when all are', async () => {
  const d = door();
  startHeld(d, 'k1');
  const run = runId(recipe, 'k1');
  let read = await readARecipeRun({ recipe, request_key: 'k1' }, { door: d });
  assert.deepEqual(read.steps, [{ id: 'look', kept: false }, { id: 'say', kept: false }]);
  assert.equal(read.finished, false);
  await submitARecipeStep({ input: { run, step: 'look', answer: { saw: 'a' } }, task: { request_key: 's1' } }, { door: d });
  read = await readARecipeRun({ recipe, request_key: 'k1' }, { door: d });
  const { kept_at: keptAt, ...first } = read.steps[0];
  assert.deepEqual(first, { id: 'look', kept: true, answer: { saw: 'a' }, kept_by: 'workflow:submit-a-recipe-step', answer_id: `${run}#answer:look` });
  assert.ok(Number.isFinite(Date.parse(keptAt)), 'the time the answer was kept');
  assert.equal(read.finished, false);
  await submitARecipeStep({ input: { run, step: 'say', answer: { said: 'b' } }, task: { request_key: 's2' } }, { door: d });
  const before = d.writes.length;
  read = await readARecipeRun({ recipe, request_key: 'k1' }, { door: d });
  assert.equal(read.finished, true);
  assert.equal(d.writes.length, before, 'a read writes nothing');
});

test('a row under an answer id that submit-a-recipe-step did not keep is no kept answer', async () => {
  const d = door();
  startHeld(d, 'k2');
  const run = runId(recipe, 'k2');
  d.held.set(`${run}#answer:look`, { id: `${run}#answer:look`, value: { kind: 'ai-job', status: 'done', parent: run, step: 'look', answer: { saw: 'forged' }, finished_by: 'someone' } });
  const read = await readARecipeRun({ recipe, request_key: 'k2' }, { door: d });
  assert.deepEqual(read.steps[0], { id: 'look', kept: false });
});

test('the run id is the one start-a-recipe-run gives', async () => {
  const d = door();
  // No recipe of the person's own is in their rows, so the starter takes the one the Workshop ships in its recipes folder.
  const started = await startARecipeRun({ input: { row: 'workflow:keep-who-appeared-in-a-recording', file: 'x' }, task: { request_key: 'k3' } }, { door: d });
  assert.deepEqual(started, { job: runId('workflow:keep-who-appeared-in-a-recording', 'k3'), status: 'written' });
  const read = await readARecipeRun({ recipe: 'workflow:keep-who-appeared-in-a-recording', request_key: 'k3' }, { door: d });
  assert.equal(read.exists, true);
  assert.equal(read.status, 'waiting');
});

test('the shipped recipe that claims a purpose is found by its default_for, and none for a purpose nobody claims', async () => {
  const { defaultRecipeFor, publicRecipe } = await import('../read-data/public-recipes.mjs');
  const setup = defaultRecipeFor('setup');
  assert.equal(typeof setup, 'string');
  assert.ok([publicRecipe(setup).default_for].flat().includes('setup'));
  assert.equal(defaultRecipeFor('a-purpose-nobody-claims'), null);
});
