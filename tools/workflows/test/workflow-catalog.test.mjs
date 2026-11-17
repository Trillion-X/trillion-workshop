// tools/workflows: an `exists` check on the workflow catalog is judged when a step is handed in, never left unchecked: a
// workflow the person keeps in their own table of workflows or one the Workshop ships exists, and any other id fails by
// name. The recipes and rows here are made up, except one id read from the shipped recipes.
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { publicRecipes } from '../read-data/public-recipes.mjs';
import { answerId, submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';
import { keep, readRow, startDatabase } from '../test-helpers/rows-in-sql.mjs';

const run = 'ai-job:workflow:made-up-find:k1';
const step = {
  id: 'find', title: 'Find', do: 'Name the workflows that fit.', submit: { type: 'object', required: ['fits'], properties: { fits: { type: 'array' } } },
  checks: [{ kind: 'exists', says: 'Every fit is a workflow the account can run', path: ['this', 'fits', '*'], catalog: 'workflow' }],
};
const shipped = publicRecipes()[0].id;

let db;
before(async () => { db = await startDatabase(); });
after(async () => { await db.stop(); });
beforeEach(async () => {
  await db.reset();
  await keep(db.sql, 'ai_job', run, { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-find', label: 'Made-up find', job: [step], input: {} });
});
const submit = (fits, key = 's1') => submitARecipeStep({ input: { run, step: 'find', answer: { fits } }, task: { request_key: key } }, { sql: db.sql });

test('a shipped recipe and the person\'s own rows exist; the check is judged, not unchecked', async () => {
  await keep(db.sql, 'workflow_recipe', 'made-up-own', { recipe: 'workflow:made-up-own' });
  await keep(db.sql, 'workflow_recipe', 'made-up-other', { recipe: 'workflow:made-up-other' });
  const kept = await submit([shipped, 'workflow:made-up-own', 'workflow:made-up-other']);
  assert.equal(kept.status, 'kept');
  assert.deepEqual(kept.checks.map(check => check.kind), ['exists']);
  assert.deepEqual(kept.unchecked, []);
});

test('a workflow nobody keeps or ships fails by name and nothing is kept', async () => {
  await assert.rejects(submit([shipped, 'workflow:made-up-nowhere']), /workflow:made-up-nowhere/);
  assert.equal(await readRow(db.sql, 'ai_job', answerId(run, 'find')), null);
});
