// tools/workflows: an `exists` check on the workflow catalog is judged when a step is handed in, never left unchecked: a
// workflow the person keeps in their own list (under any of their recipe row types) or one the Workshop ships exists, and
// any other id fails by name. The recipes and rows here are made up, except one id read from the shipped recipes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { publicRecipes } from '../read-data/public-recipes.mjs';
import { answerId, submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';

const run = 'ai-job:workflow:made-up-find:k1';
const step = {
  id: 'find', title: 'Find', do: 'Name the workflows that fit.', submit: { type: 'object', required: ['fits'], properties: { fits: { type: 'array' } } },
  checks: [{ kind: 'exists', says: 'Every fit is a workflow the account can run', path: ['this', 'fits', '*'], catalog: 'workflow' }],
};
const shipped = publicRecipes()[0].id;

function memoryDoor(rows = {}) {
  const held = new Map([[`ai-job\n${run}`, { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-find', label: 'Made-up find', job: [step], input: {} }]]);
  for (const [key, value] of Object.entries(rows)) held.set(key, value);
  return {
    held,
    read: async (type, id) => held.get(`${type}\n${id}`) ?? null,
    async *list() {},
    write: async records => { for (const record of records) held.set(`${record.type}\n${record.id}`, record.value); },
  };
}
const submit = (door, fits, key = 's1') => submitARecipeStep({ input: { run, step: 'find', answer: { fits } }, task: { request_key: key } }, { door });

test('a shipped recipe and the person\'s own rows, under either recipe row type, exist; the check is judged, not unchecked', async () => {
  const door = memoryDoor({
    'record:workflow-recipe\nrecord:workflow-recipe:made-up-own': { recipe: 'workflow:made-up-own' },
    'workflow-recipe\nrecord:workflow-recipe:made-up-older': { recipe: 'workflow:made-up-older' },
  });
  const kept = await submit(door, [shipped, 'workflow:made-up-own', 'workflow:made-up-older']);
  assert.equal(kept.status, 'kept');
  assert.deepEqual(kept.checks.map(check => check.kind), ['exists']);
  assert.deepEqual(kept.unchecked, []);
});

test('a workflow nobody keeps or ships fails by name and nothing is kept', async () => {
  const door = memoryDoor();
  await assert.rejects(submit(door, [shipped, 'workflow:made-up-nowhere']), /workflow:made-up-nowhere/);
  assert.equal(door.held.has(`ai-job\n${answerId(run, 'find')}`), false);
});
