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
const recipe = JSON.parse(readFileSync(new URL('../recipes/read-the-week-and-make-more-of-what-won.json', import.meta.url), 'utf8')).records[0].payload;
const cause = { kind: 'time', tool: recipeId, wake: 'monday', due_ms: 1800000000000 };
const started = { input: { row: recipeId, start_at: 'read-pieces' }, task: { request_key: 'cause-key-1', cause } };

test('the recipes source runs every recipe as the starter', () => {
  assert.equal(rowOf(rows, 'source:workflow-recipes').invoke_with, 'tool:start-a-recipe-run');
  assert.equal(starter.invoke_with, undefined, 'the starter runs as itself');
  assert.deepEqual(starter.invoke.records.rights, [{ kind: 'ai-job', operations: ['records:read', 'records:write'] }]);
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
