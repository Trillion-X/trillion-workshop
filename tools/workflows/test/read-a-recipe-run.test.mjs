// tools/workflows: where a recipe run stands is read from the run's own rows, the job start-a-recipe-run writes and the
// answers submit-a-recipe-step keeps, and nothing is written. Every recipe and step name here is made up.
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { readARecipeRun, runId } from '../read-data/read-a-recipe-run.mjs';
import { startARecipeRun } from '../read-data/start-a-recipe-run.mjs';
import { submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';
import { startDatabase } from '../test-helpers/rows-in-sql.mjs';

const recipe = 'workflow:made-up-two-steps';
const steps = [
  { id: 'look', title: 'Look', do: 'Look.', submit: { type: 'object' }, checks: [] },
  { id: 'say', title: 'Say', do: 'Say.', submit: { type: 'object' }, checks: [] },
];

let db;
before(async () => { db = await startDatabase(); });
after(async () => { await db.stop(); });
beforeEach(async () => { await db.reset(); });
const count = async () => Number((await db.sql('select count(*) as n from ai_job'))[0].n);
const startHeld = (key) => db.sql('insert into ai_job (id, value) values ($1, $2::jsonb)', [runId(recipe, key), JSON.stringify({ kind: 'ai-job', status: 'waiting', row: recipe, label: 'Made up', job: steps, input: {} })]);
const submit = (input, key) => submitARecipeStep({ input, task: { request_key: key } }, { sql: db.sql });

test('a run never started reads as not there, with no steps and nothing written', async () => {
  assert.deepEqual(await readARecipeRun({ recipe, request_key: 'k1' }, { sql: db.sql }),
    { run: 'ai-job:workflow:made-up-two-steps:k1', exists: false, status: null, label: null, input: null, steps: [], finished: false });
  assert.equal(await count(), 0);
});

test('a started run reads each step kept only once its checked answer is kept, and finished when all are', async () => {
  await startHeld('k1');
  const run = runId(recipe, 'k1');
  let read = await readARecipeRun({ recipe, request_key: 'k1' }, { sql: db.sql });
  assert.deepEqual(read.steps, [{ id: 'look', kept: false }, { id: 'say', kept: false }]);
  assert.equal(read.finished, false);
  await submit({ run, step: 'look', answer: { saw: 'a' } }, 's1');
  read = await readARecipeRun({ recipe, request_key: 'k1' }, { sql: db.sql });
  const { kept_at: keptAt, ...first } = read.steps[0];
  assert.deepEqual(first, { id: 'look', kept: true, answer: { saw: 'a' }, kept_by: 'workflow:submit-a-recipe-step', answer_id: `${run}#answer:look` });
  assert.ok(Number.isFinite(Date.parse(keptAt)), 'the time the answer was kept');
  assert.equal(read.finished, false);
  await submit({ run, step: 'say', answer: { said: 'b' } }, 's2');
  const before = await count();
  read = await readARecipeRun({ recipe, request_key: 'k1' }, { sql: db.sql });
  assert.equal(read.finished, true);
  assert.equal(await count(), before, 'a read writes nothing');
});

test('a row under an answer id that submit-a-recipe-step did not keep is no kept answer', async () => {
  await startHeld('k2');
  const run = runId(recipe, 'k2');
  await db.sql('insert into ai_job (id, value) values ($1, $2::jsonb)', [`${run}#answer:look`, JSON.stringify({ kind: 'ai-job', status: 'done', parent: run, step: 'look', answer: { saw: 'forged' }, finished_by: 'someone' })]);
  const read = await readARecipeRun({ recipe, request_key: 'k2' }, { sql: db.sql });
  assert.deepEqual(read.steps[0], { id: 'look', kept: false });
});

test('the run id is the one start-a-recipe-run gives', async () => {
  // No recipe of the person's own is in their rows, so the starter takes the one the Workshop ships in its recipes folder.
  const started = await startARecipeRun({ input: { row: 'workflow:keep-who-appeared-in-a-recording', file: 'x' }, task: { request_key: 'k3' } }, { sql: db.sql });
  assert.deepEqual(started, { job: runId('workflow:keep-who-appeared-in-a-recording', 'k3'), status: 'written' });
  const read = await readARecipeRun({ recipe: 'workflow:keep-who-appeared-in-a-recording', request_key: 'k3' }, { sql: db.sql });
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
