// tools/workflows: tool:start-a-recipe-run, run the way the container runs its row, against the fake records door with
// exactly the row's rights: one ai-job record per request key holding the recipe's steps, nothing written again on a
// second firing, and the recipes' row source naming it in invoke_with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow, rowOf } from '../../records-door/test/run-row.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const starter = rowOf(rows, 'tool:start-a-recipe-run');
const recipeId = 'workflow:read-the-week-and-make-more-of-what-won';
const recipe = JSON.parse(readFileSync(new URL('../recipes/workflows.json', import.meta.url), 'utf8')).records.map(record => record.payload).find(payload => payload.id === recipeId);
const cause = { kind: 'time', tool: recipeId, wake: 'monday', due_ms: 1800000000000 };
const started = { input: { row: recipeId, start_at: 'read-pieces' }, task: { request_key: 'cause-key-1', cause } };

test('the recipes source runs every recipe as the starter', () => {
  assert.equal(rowOf(rows, 'source:workflow-recipes').invoke_with, 'tool:start-a-recipe-run');
  assert.equal(starter.invoke_with, undefined, 'the starter runs as itself');
  assert.deepEqual(starter.invoke.records.rights, [
    { kind: 'ai-job', operations: ['records:read', 'records:write'] },
    { kind: 'record:workflow-recipe', operations: ['records:read'] },
    { kind: 'record:workflow-step', operations: ['records:list'], prefix: 'record:workflow-step:' },
  ]);
});

test('a firing writes one waiting ai-job holding the recipe steps, its input and its cause', async () => {
  const ran = await runRow(starter, started);
  assert.equal(ran.status, 0);
  const id = `ai-job:${recipeId}:cause-key-1`;
  assert.deepEqual(ran.result, { job: id, status: 'written' });
  assert.equal(ran.kept.length, 1);
  const [job] = ran.kept;
  assert.equal(job.id, id);
  assert.equal(job.type, 'ai-job');
  assert.equal(job.value.status, 'waiting');
  assert.equal(job.value.row, recipeId);
  assert.deepEqual(job.value.job, recipe.steps);
  assert.deepEqual(job.value.input, { start_at: 'read-pieces' });
  assert.deepEqual(job.value.cause, cause);
});

test('the same firing again finds its job and writes nothing, even after the AI marked it done', async () => {
  const id = `ai-job:${recipeId}:cause-key-1`;
  const done = { id, type: 'ai-job', value: { kind: 'ai-job', status: 'done', row: recipeId } };
  const ran = await runRow(starter, started, { records: [done] });
  assert.deepEqual(ran.result, { job: id, status: 'already-there' });
  assert.deepEqual(ran.kept, [done]);
  assert.ok(!ran.calls.some(call => call.method === 'records:write'));
});

test('a recipe that is not in the folder writes nothing and says so', async () => {
  const ran = await runRow(starter, { ...started, input: { row: 'workflow:not-a-recipe' } });
  assert.match(ran.error, /No recipe workflow:not-a-recipe/);
  assert.deepEqual(ran.kept, []);
});

// A person's own list of workflows, as the door holds it: one recipe row and the rows of its steps.
const ownRows = slug => [
  { id: `record:workflow-recipe:${slug}`, type: 'record:workflow-recipe', value: { title: 'My own version', recipe: `workflow:${slug}`, job: 'The person\'s own job.', input_schema: '{"type":"object"}', flags: ['public'] } },
  { id: `record:workflow-step:${slug}--second`, type: 'record:workflow-step', value: { title: 'Second', recipe: [slug], position: 2, step: 'second', do: 'Do the second.', submit: '{"type":"object"}' } },
  { id: `record:workflow-step:${slug}--first`, type: 'record:workflow-step', value: { title: 'First', recipe: [slug], position: 1, step: 'first', do: 'Do the first.', submit: '{"type":"object"}', checks: '[]' } },
  { id: `record:workflow-step:${slug}--other`, type: 'record:workflow-step', value: { title: 'Another recipe\'s', recipe: ['somebody-else'], position: 1, step: 'other', do: 'Not this one.', submit: '{"type":"object"}' } },
];

test('a recipe only in the person\'s own list of workflows is started from its row and its step rows, in order', async () => {
  const slug = 'a-recipe-only-i-keep';
  const ran = await runRow(starter, { ...started, input: { row: `workflow:${slug}` } }, { records: ownRows(slug) });
  assert.equal(ran.status, 0);
  const [job] = ran.kept.filter(record => record.type === 'ai-job');
  assert.equal(job.value.label, 'My own version');
  assert.deepEqual(job.value.job.map(step => step.id), ['first', 'second']);
});

test('when the person\'s list and the public recipes both hold the id, the person\'s own row wins', async () => {
  const ran = await runRow(starter, started, { records: ownRows(recipeId.replace('workflow:', '')) });
  const [job] = ran.kept.filter(record => record.type === 'ai-job');
  assert.equal(job.value.label, 'My own version');
  assert.notDeepEqual(job.value.job, recipe.steps);
});
