// tools/workflows: tool:start-a-recipe-run against a real PostgreSQL server: one ai_job row per request key holding the
// recipe's steps, nothing written again on a second firing, the person's own workflow rows winning over a public recipe,
// an arrival source naming the table its changed rows are read from, and the shipped row run as the engine runs it
// (its packed files laid under one folder, the connection on descriptor 3, no records door).
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { checkOutcome } from '../../hand-work-to-ais/read-data/ai-work.mjs';
import { startARecipeRun } from '../read-data/start-a-recipe-run.mjs';
import { keep, keepWorkflow, readRow, runRowIn, startDatabase } from '../test-helpers/rows-in-sql.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const starter = rowOf(rows, 'tool:start-a-recipe-run');
const recipeId = 'workflow:read-the-week-and-make-more-of-what-won';
const recipe = JSON.parse(readFileSync(new URL('../recipes/workflows.json', import.meta.url), 'utf8')).records.map(record => record.payload).find(payload => payload.id === recipeId);
const cause = { kind: 'time', tool: recipeId, wake: 'monday', due_ms: 1800000000000 };
const started = { row: recipeId, start_at: 'read-pieces' };
const jobId = `ai-job:${recipeId}:cause-key-1`;

let db;
before(async () => { db = await startDatabase(); });
after(async () => { await db.stop(); });
beforeEach(async () => { await db.reset(); });

// One firing of the starter, called as the entry calls it.
const fire = (input, key = 'cause-key-1', firedCause = cause) => startARecipeRun({ input, task: { request_key: key, cause: firedCause } }, { sql: db.sql });
const jobs = () => db.sql('select id, status, value from ai_job order by id');

test('the recipes source runs every recipe as the starter', () => {
  assert.equal(rowOf(rows, 'source:workflow-recipes').invoke_with, 'tool:start-a-recipe-run');
  assert.equal(starter.invoke_with, undefined, 'the starter runs as itself');
});

test('a firing writes one waiting ai_job holding the recipe steps, its input and its cause', async () => {
  assert.deepEqual(await fire(started), { job: jobId, status: 'written' });
  const [job] = await jobs();
  assert.equal(job.id, jobId);
  assert.equal(job.status, 'waiting', 'the status column is the value\'s own status');
  assert.equal(job.value.kind, 'ai-job');
  assert.equal(job.value.row, recipeId);
  assert.deepEqual(job.value.job, recipe.steps);
  assert.equal(job.value.outcome, recipe.job ?? recipe.label, 'the run says what it is for in words, so a finish can be checked against it');
  // and the run's job can be finished: the finish check names that outcome (its step list could never be named)
  const taken = { ...job.value, status: 'taken', taken_at: '2026-11-15T12:00:00.000Z' };
  const check = { outcome: job.value.outcome, checked_at: '2026-11-15T12:05:00.000Z', evidence: [{ ref: jobId, observation: 'every step has its kept answer' }] };
  assert.doesNotThrow(() => checkOutcome(check, taken, new Date('2026-11-15T12:10:00.000Z')));
  assert.deepEqual(job.value.input, { start_at: 'read-pieces' });
  assert.deepEqual(job.value.cause, cause);
});

test('the same firing again finds its job and writes nothing, even after the AI marked it done', async () => {
  await fire(started);
  await db.sql(`update ai_job set value = jsonb_set(value, '{status}', '"done"') where id = $1`, [jobId]);
  assert.deepEqual(await fire(started), { job: jobId, status: 'already-there' });
  const [job] = await jobs();
  assert.equal(job.status, 'done', 'the finished job is not written over');
});

test('firings that race for one request key write one row, and every one of them answers its id', async () => {
  const callers = await Promise.all(Array.from({ length: 8 }, () => db.another()));
  const answers = await Promise.all(callers.map(({ sql }) => startARecipeRun({ input: started, task: { request_key: 'cause-key-1', cause } }, { sql })));
  await Promise.all(callers.map(({ end }) => end()));
  assert.ok(answers.every(answer => answer.job === jobId));
  assert.equal(answers.filter(answer => answer.status === 'written').length, 1);
  assert.equal((await jobs()).length, 1);
});

test('a recipe that is not in the folder writes nothing and says so', async () => {
  await assert.rejects(fire({ row: 'workflow:not-a-recipe' }), /No recipe workflow:not-a-recipe/);
  assert.deepEqual(await jobs(), []);
});

const ownWorkflow = slug => ({
  recipe: { title: 'My own version', recipe: `workflow:${slug}`, job: 'The person\'s own job.', input_schema: '{"type":"object"}', flags: ['public'] },
  steps: [
    { title: 'Second', recipe: [slug], position: 2, step: 'second', do: 'Do the second.', submit: '{"type":"object"}' },
    { title: 'First', recipe: [slug], position: 1, step: 'first', do: 'Do the first.', submit: '{"type":"object"}', checks: '[]' },
  ],
});

test('a recipe only in the person\'s own table of workflows is started from its row and its step rows, in order', async () => {
  const slug = 'a-recipe-only-i-keep';
  await keepWorkflow(db.sql, slug, ownWorkflow(slug));
  // another recipe's step is in the table too and is not this recipe's
  await db.sql('insert into workflow_step (id, recipe, position, value) values ($1, $2, 1, $3::jsonb)', ['somebody-else--other', 'somebody-else', JSON.stringify({ title: 'Other', recipe: ['somebody-else'], position: 1, step: 'other', do: 'Not this one.', submit: '{"type":"object"}' })]);
  assert.equal((await fire({ row: `workflow:${slug}` })).status, 'written');
  const [job] = await jobs();
  assert.equal(job.value.label, 'My own version');
  assert.deepEqual(job.value.job.map(step => step.id), ['first', 'second']);
});

test('when the person\'s table and the public recipes both hold the id, the person\'s own row wins', async () => {
  const slug = recipeId.replace('workflow:', '');
  await keepWorkflow(db.sql, slug, ownWorkflow(slug));
  await fire(started);
  const [job] = await jobs();
  assert.equal(job.value.label, 'My own version');
  assert.notDeepEqual(job.value.job, recipe.steps);
});

test('a row of the person\'s own that holds no steps and no definition only adds to the installed recipe, which runs', async () => {
  await keep(db.sql, 'workflow_recipe', recipeId.replace('workflow:', ''), { title: 'Only a condition', recipe: recipeId, job: 'x', fires_when: '[]' });
  await fire(started);
  const [job] = await jobs();
  assert.deepEqual(job.value.job, recipe.steps);
  assert.equal(job.value.label, recipe.label);
});

// A made-up arrival source: messages, kept only when a person wrote them, each mapped to a seed.
const source = {
  label: 'Made-up messages', read_table: 'made_up_message', state: 'On',
  filter: JSON.stringify({ fields: [{ id: 'speaker', kind: 'text', path: ['speaker'] }], tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'speaker', operator: 'is_text', params: { text: 'person' } }] } }),
  seed: JSON.stringify({ words: ['text'], came_from: ['id'], at: ['at'] }),
};
const message = (id, speaker, text) => keep(db.sql, 'made_up_message', id, { speaker, text, at: '2026-01-02T03:04:05.000Z', app: 'Made-up app' });
const woken = changes => ({ kind: 'record', wake: 'message-arrived', detail: { changes } });
const fireWoken = (changes, sourceId = 'made-up-messages') => fire({ ...started, arrival_source: sourceId }, 'cause-key-2', woken(changes));

test('a person\'s message named by the cause starts the run with it as a seed, and the AI reply beside it does not', async () => {
  await keep(db.sql, 'arrival_source', 'made-up-messages', source);
  await message('message:a', 'person', 'A thought worth growing.');
  await message('message:b', 'ai', 'An answer from the AI.');
  const answer = await fireWoken([{ id: 'message:a', deleted: false }, { id: 'message:b', deleted: false }]);
  assert.equal(answer.status, 'written');
  const [job] = await jobs();
  assert.deepEqual(job.value.input.seeds, [{ words: 'A thought worth growing.', came_from: 'message:a', at: '2026-01-02T03:04:05.000Z' }]);
});

test('a cause naming only an AI reply, or only a deleted row, writes nothing', async () => {
  await keep(db.sql, 'arrival_source', 'made-up-messages', source);
  await message('message:a', 'person', 'A thought.');
  await message('message:b', 'ai', 'An answer.');
  for (const changes of [[{ id: 'message:b', deleted: false }], [{ id: 'message:a', deleted: true }], [{ id: 'message:gone', deleted: false }]]) {
    assert.deepEqual(await fireWoken(changes), { job: null, status: 'nothing-arrived' });
  }
  assert.deepEqual(await jobs(), []);
});

test('a source that is off starts nothing, a missing source is refused, and a source naming no table is refused', async () => {
  await message('message:a', 'person', 'A thought.');
  await keep(db.sql, 'arrival_source', 'made-up-messages', { ...source, state: 'Off' });
  assert.deepEqual(await fireWoken([{ id: 'message:a', deleted: false }]), { job: null, status: 'nothing-arrived' });
  await assert.rejects(fireWoken([{ id: 'message:a', deleted: false }], 'no-such-source'), /no arrival source no-such-source/);
  await keep(db.sql, 'arrival_source', 'no-table', { ...source, read_table: undefined });
  await assert.rejects(fireWoken([{ id: 'message:a', deleted: false }], 'no-table'), /names no read_table/);
});

test('the table a source reads is only ever one quoted name, however it is spelled', async () => {
  await keep(db.sql, 'arrival_source', 'sneaky', { ...source, read_table: 'made_up_message"; drop table ai_job; --' });
  await assert.rejects(fireWoken([{ id: 'message:a', deleted: false }], 'sneaky'), /does not exist/);
  assert.deepEqual(await db.sql("select to_regclass('ai_job') is not null as there"), [{ there: true }]);
});

test('the shipped row, run as the engine runs it, makes its tables and writes the job from the connection on descriptor 3', async () => {
  const ran = await runRowIn(starter, { input: started, task: { request_key: 'cause-key-1', cause } }, { connection: db.connection });
  assert.equal(ran.code, 0, ran.stderr + ran.out);
  assert.deepEqual(ran.last, { result: { job: jobId, status: 'written' } });
  const again = await runRowIn(starter, { input: started, task: { request_key: 'cause-key-1', cause } }, { connection: db.connection });
  assert.deepEqual(again.last, { result: { job: jobId, status: 'already-there' } });
  assert.equal((await jobs()).length, 1);
  assert.deepEqual(await readRow(db.sql, 'ai_job', jobId).then(value => value.job), recipe.steps);
});

test('the shipped row without a connection, or with a wrong one, answers an error that holds no password', async () => {
  const none = await runRowIn(starter, { input: started, task: { request_key: 'k' } }, { connection: '' });
  assert.equal(none.code, 1);
  assert.match(none.last.error, /No connection/);
  const wrong = await runRowIn(starter, { input: started, task: { request_key: 'k' } }, { connection: db.connection.replace('made-up-admin-pw', 'not-the-password') });
  assert.equal(wrong.code, 1);
  assert.ok(wrong.last.error);
  assert.ok(!wrong.out.includes('not-the-password') && !wrong.stderr.includes('not-the-password'));
});
