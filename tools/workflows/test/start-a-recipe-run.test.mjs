// tools/workflows: tool:start-a-recipe-run, run the way the container runs its row, against the fake records door with
// exactly the row's rights: one ai-job record per request key holding the recipe's steps, nothing written again on a
// second firing, and the recipes' row source naming it in invoke_with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const starter = rowOf(rows, 'tool:start-a-recipe-run');
const recipeId = 'workflow:read-the-week-and-make-more-of-what-won';
const recipe = JSON.parse(readFileSync(new URL('../recipes/workflows.json', import.meta.url), 'utf8')).records.map(record => record.payload).find(payload => payload.id === recipeId);
const cause = { kind: 'time', tool: recipeId, wake: 'monday', due_ms: 1800000000000 };
const started = { row: recipeId, start_at: 'read-pieces' };
// One firing of the starter: its input as the row's stdin fill hands it, under a task holding this request key and cause.
const fire = (input, sample = {}) => answerOf(starter, input, { task: { request_key: 'cause-key-1', cause }, ...sample });

test('the recipes source runs every recipe as the starter', () => {
  assert.equal(rowOf(rows, 'source:workflow-recipes').invoke_with, 'tool:start-a-recipe-run');
  assert.equal(starter.invoke_with, undefined, 'the starter runs as itself');
  assert.deepEqual(starter.invoke.records.rights, [
    { kind: 'ai-job', operations: ['records:read', 'records:write'] },
    { kind: 'record:workflow-recipe', operations: ['records:read'] },
    { kind: 'record:workflow-step', operations: ['records:list'], prefix: 'record:workflow-step:' },
    { kind: 'workflow-recipe', operations: ['records:read'] },
    { kind: 'workflow-step', operations: ['records:list'], prefix: 'record:workflow-step:' },
    { kind: 'record:arrival-sources', operations: ['records:read'] },
    { kind: 'message', operations: ['records:read'] },
    { kind: 'record:inputs-arrivals', operations: ['records:read'] },
    { kind: 'record:broad-condition', operations: ['records:read'] },
  ]);
});

test('a firing writes one waiting ai-job holding the recipe steps, its input and its cause', async () => {
  const ran = await fire(started);
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
  const ran = await fire(started, { records: [done] });
  assert.deepEqual(ran.result, { job: id, status: 'already-there' });
  assert.deepEqual(ran.kept, [done]);
  assert.ok(!ran.calls.some(call => call.method === 'records:write'));
});

test('a recipe that is not in the folder writes nothing and says so', async () => {
  const ran = await fire({ row: 'workflow:not-a-recipe' });
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
  const ran = await fire({ row: `workflow:${slug}` }, { records: ownRows(slug) });
  assert.equal(ran.status, 0);
  const [job] = ran.kept.filter(record => record.type === 'ai-job');
  assert.equal(job.value.label, 'My own version');
  assert.deepEqual(job.value.job.map(step => step.id), ['first', 'second']);
});

test('when the person\'s list and the public recipes both hold the id, the person\'s own row wins', async () => {
  const ran = await fire(started, { records: ownRows(recipeId.replace('workflow:', '')) });
  const [job] = ran.kept.filter(record => record.type === 'ai-job');
  assert.equal(job.value.label, 'My own version');
  assert.notDeepEqual(job.value.job, recipe.steps);
});

// The same rows under the account's older kinds (workflow-recipe, workflow-step), as a real person's account holds them.
const olderTyped = slug => ownRows(slug).map(record => ({ ...record, type: record.type.replace('record:', '') }));

test('a person\'s own rows typed workflow-recipe and workflow-step win over the public recipe too', async () => {
  const ran = await fire(started, { records: olderTyped(recipeId.replace('workflow:', '')) });
  assert.equal(ran.status, 0);
  const [job] = ran.kept.filter(record => record.type === 'ai-job');
  assert.equal(job.value.label, 'My own version');
  assert.deepEqual(job.value.job.map(step => step.id), ['first', 'second']);
});

// A made-up arrival source: messages, kept only when a person wrote them, each mapped to a seed.
const source = { id: 'record:arrival-sources:made-up-messages', type: 'record:arrival-sources', value: {
  label: 'Made-up messages', read_type: 'message', state: 'On',
  filter: JSON.stringify({ fields: [{ id: 'speaker', kind: 'text', path: ['speaker'] }], tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'speaker', operator: 'is_text', params: { text: 'person' } }] } }),
  seed: JSON.stringify({ words: ['text'], came_from: ['id'], at: ['at'] }),
} };
const message = (id, speaker, text) => ({ id, type: 'message', value: { speaker, text, at: '2026-01-02T03:04:05.000Z', app: 'Made-up app' } });
const woken = changes => ({ kind: 'record', wake: 'message-arrived', detail: { resource: 'own-records', changes } });
const fireWoken = (changes, records) => answerOf(starter, { ...started, arrival_source: source.id }, { task: { request_key: 'cause-key-2', cause: woken(changes) }, records });

test('a person\'s message named by the cause starts the run with it as a seed, and the AI reply beside it does not', async () => {
  const records = [source, message('message:a', 'person', 'A thought worth growing.'), message('message:b', 'ai', 'An answer from the AI.')];
  const ran = await fireWoken([{ id: 'message:a', deleted: false }, { id: 'message:b', deleted: false }], records);
  assert.equal(ran.status, 0);
  assert.equal(ran.result.status, 'written');
  const [job] = ran.kept.filter(record => record.type === 'ai-job');
  assert.deepEqual(job.value.input.seeds, [{ words: 'A thought worth growing.', came_from: 'message:a', at: '2026-01-02T03:04:05.000Z' }]);
});

test('a cause naming only an AI reply, or only a deleted row, writes nothing', async () => {
  for (const changes of [[{ id: 'message:b', deleted: false }], [{ id: 'message:a', deleted: true }]]) {
    const ran = await fireWoken(changes, [source, message('message:a', 'person', 'A thought.'), message('message:b', 'ai', 'An answer.')]);
    assert.equal(ran.status, 0);
    assert.deepEqual(ran.result, { job: null, status: 'nothing-arrived' });
    assert.ok(!ran.calls.some(call => call.method === 'records:write'));
  }
});

test('a source that is off starts nothing, and a missing source is refused', async () => {
  const off = { ...source, value: { ...source.value, state: 'Off' } };
  const ran = await fireWoken([{ id: 'message:a', deleted: false }], [off, message('message:a', 'person', 'A thought.')]);
  assert.deepEqual(ran.result, { job: null, status: 'nothing-arrived' });
  const missing = await fireWoken([{ id: 'message:a', deleted: false }], [message('message:a', 'person', 'A thought.')]);
  assert.match(missing.error, /no arrival source/);
});

test('every published record wake that starts from an arrival source may read the rows it wakes on', () => {
  // A firing reads each changed row under the source's read_type; a right the starter lacks refuses the whole run
  // ("This tool may not reach those records.", Nov 14 2026: rewrite-a-broad-condition's broad-found wake).
  const readable = new Set(starter.invoke.records.rights.filter(right => right.operations.includes('records:read')).map(right => right.kind));
  const recipes = JSON.parse(readFileSync(new URL('../recipes/workflows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const woken = recipes.flatMap(recipe => (recipe.wakes ?? []).filter(wake => wake.on.record?.prefix && wake.input?.arrival_source)
    .map(wake => ({ recipe: recipe.id, wake: wake.id, kind: wake.on.record.prefix.replace(/:$/, '').split(':').slice(0, 2).join(':') })));
  assert.ok(woken.length >= 1, 'at least one published recipe wakes on an arrival source');
  for (const { recipe, wake, kind } of woken) assert.ok(readable.has(kind), `${recipe} wake ${wake} reads ${kind}`);
});
