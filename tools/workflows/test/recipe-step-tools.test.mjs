// tools/workflows: the tools the run's AI uses to go through a recipe run's steps. Beginning a step starts its lane jobs
// itself when the step has several agents; handing in a step's answer builds the `ran-job` catalog from each lane's own
// ai-job and takes no catalog from the caller. Every recipe here is made up; no number below is known to the code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import { laneAiId, laneCommands, laneIds, laneJobId } from '../read-data/step-agents.mjs';
import { startARecipeStep } from '../read-data/start-a-recipe-step.mjs';
import { answerId, submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { readRow, runRowIn, startDatabase } from '../test-helpers/rows-in-sql.mjs';

const laneCheck = { kind: 'lane-jobs', path: ['this', 'lanes'], lane: 'id', job: 'job', says: 'Every lane comes from its own job that ran' };
const stepOf = (extra = {}) => ({ id: 'dig', title: 'Dig', do: 'Dig in your lane.', submit: { type: 'object' }, checks: [laneCheck], ...extra });
const run = 'ai-job:workflow:made-up-dig:k1';

let db;
before(async () => { db = await startDatabase(); });
after(async () => { await db.stop(); });
beforeEach(async () => { await db.reset(); });

const sql = (...args) => db.sql(...args);
const setJob = (id, value) => sql('insert into ai_job (id, value) values ($1, $2::jsonb) on conflict (id) do update set value = excluded.value', [id, JSON.stringify(value)]);
const jobRow = id => readRow(db.sql, 'ai_job', id);
const patchJob = async (id, patch) => setJob(id, { ...(await jobRow(id)), ...patch });
const count = async () => (await sql('select count(*)::int as n from ai_job'))[0].n;
const startRun = (steps, input = { topic: 'made up' }) => setJob(run, { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-dig', label: 'Made-up dig', job: steps, input });
const finish = async (step, taker = lane => `ai:taker-of-${lane}`) => {
  for (const lane of laneIds(step)) await patchJob(laneJobId(run, step.id, lane), { status: 'done', finished_by: taker(lane) });
};
const answerFor = step => ({ lanes: laneIds(step).map(id => ({ id, job: laneJobId(run, step.id, id) })) });
const submit = (input, key = 's1') => submitARecipeStep({ input, task: { request_key: key } }, { sql: db.sql });

test('beginning a step with several agents starts its lane jobs in the same call, and hands back the step and the lanes', async () => {
  for (const agents of [2, 6, 40]) {
    await db.reset();
    const step = stepOf({ agents });
    await startRun([step]);
    const began = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
    assert.equal(began.status, 'written');
    assert.equal(began.step.id, 'dig');
    assert.deepEqual(began.lane_jobs.map(({ lane, job }) => ({ lane, job })), laneIds(step).map(lane => ({ lane, job: laneJobId(run, 'dig', lane) })));
    for (const { job } of began.lane_jobs) assert.equal((await jobRow(job)).status, 'waiting', `${agents} agents`);
  }
});

test('beginning a step with one agent starts nothing, and beginning twice changes nothing', async () => {
  await startRun([stepOf({ id: 'plain', checks: [] }), stepOf({ agents: 3 })]);
  const plain = await startARecipeStep({ input: { run, step: 'plain' }, task: { request_key: 'b1' } }, { sql: db.sql });
  assert.deepEqual([plain.status, plain.lane_jobs], ['one-agent', []]);
  assert.equal(await count(), 1, 'only the run itself, and the starts above wrote none');
  const first = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b2' } }, { sql: db.sql });
  const before = await count();
  const again = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b3' } }, { sql: db.sql });
  assert.equal(again.status, 'already-there');
  assert.deepEqual(again.lane_jobs, first.lane_jobs);
  assert.equal(await count(), before);
  await assert.rejects(startARecipeStep({ input: { run, step: 'nothing' }, task: { request_key: 'b4' } }, { sql: db.sql }), /no step "nothing"/);
});

test('an answer is kept when every lane\'s own job is done by a different taker, and only then', async () => {
  const step = stepOf({ agents: 6 });
  await startRun([step]);
  await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
  await assert.rejects(submit({ run, step: 'dig', answer: answerFor(step) }), /fails/, 'no lane job has run yet');
  assert.equal(await jobRow(answerId(run, 'dig')) !== null, false);
  await finish(step);
  const kept = await submit({ run, step: 'dig', answer: answerFor(step) });
  assert.equal(kept.status, 'kept');
  assert.deepEqual(kept.checks.map(check => check.kind), ['lane-jobs']);
  assert.deepEqual((await jobRow(answerId(run, 'dig'))).answer, answerFor(step));
  const again = await submit({ run, step: 'dig', answer: { lanes: [] } }, 's2');
  assert.equal(again.status, 'already-there');
  assert.deepEqual((await jobRow(answerId(run, 'dig'))).answer, answerFor(step), 'the first answer stays');
});

test('one AI finishing the six lane jobs does not pass, nor does a lane job started but not finished', async () => {
  const step = stepOf({ agents: 6 });
  await startRun([step]);
  await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
  await finish(step, () => 'ai:one-worker');
  await assert.rejects(submit({ run, step: 'dig', answer: answerFor(step) }), /fails/);
  await finish(step);
  const waiting = laneJobId(run, 'dig', laneIds(step)[5]);
  await patchJob(waiting, { status: 'waiting', finished_by: undefined });
  await assert.rejects(submit({ run, step: 'dig', answer: answerFor(step) }), new RegExp(laneIds(step)[5]));
  assert.equal(await jobRow(answerId(run, 'dig')) !== null, false);
});

test('a caller cannot give a catalog, or anything else the checks would take on its word', async () => {
  const step = stepOf({ agents: 2 });
  await startRun([step]);
  await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
  for (const extra of [{ catalogs: { 'ran-job': () => 'ai:x' } }, { catalog: { x: 'ai:y' } }, { ran: ['a'] }, { takers: {} }]) {
    await assert.rejects(submit({ run, step: 'dig', answer: answerFor(step), ...extra }), /is not taken/, JSON.stringify(Object.keys(extra)));
  }
  assert.equal(await jobRow(answerId(run, 'dig')) !== null, false);
});

test('a job of an invented lane or of another step cannot stand in: only the run\'s own lane jobs are read', async () => {
  const step = stepOf({ agents: 2 });
  await startRun([step]);
  await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
  await finish(step);
  await setJob('ai-job:other', { kind: 'ai-job', status: 'done', finished_by: 'ai:third' });
  const bent = { lanes: [{ id: 'dig-1', job: laneJobId(run, 'dig', 'dig-1') }, { id: 'dig-2', job: 'ai-job:other' }] };
  await assert.rejects(submit({ run, step: 'dig', answer: bent }), /fails/);
});

test('a later step reads the answers kept for earlier steps, and cannot be handed in before them', async () => {
  const first = stepOf({ id: 'scope', checks: [], submit: { type: 'object' } });
  const second = stepOf({ id: 'plan', checks: [{ kind: 'subset-of', path: ['this', 'topics'], of: ['steps', 'scope', 'topics'], says: 'Plan only what scope named' }] });
  await startRun([first, second]);
  await assert.rejects(submit({ run, step: 'plan', answer: { topics: ['a'] } }), /Step "scope" has no answer kept/);
  await submit({ run, step: 'scope', answer: { topics: ['a', 'b'] } });
  await assert.rejects(submit({ run, step: 'plan', answer: { topics: ['c'] } }), /fails/);
  assert.equal((await submit({ run, step: 'plan', answer: { topics: ['a'] } }, 's3')).status, 'kept');
});

test('a check this tool cannot judge is listed as unchecked, never as passed', async () => {
  const step = stepOf({ checks: [{ kind: 'exists', catalog: 'tool', path: ['this', 'tool'], says: 'The tool is real' }] });
  await startRun([step]);
  const kept = await submit({ run, step: 'dig', answer: { tool: 'tool:x' } });
  assert.equal(kept.status, 'kept');
  assert.deepEqual(kept.checks, []);
  assert.equal(kept.unchecked.length, 1);
});

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const connection = () => ({ connection: db.connection });
test('the shipped rows take only run, step and answer, and run as their rows do', async () => {
  const begin = rowOf(rows, 'tool:start-a-recipe-step'), hand = rowOf(rows, 'tool:submit-a-recipe-step');
  assert.equal(hand.input_schema.additionalProperties, false);
  assert.deepEqual(Object.keys(hand.input_schema.properties).sort(), ['answer', 'run', 'step']);
  const step = stepOf({ agents: 6 });
  await startRun([step], {});
  const began = await runRowIn(begin, { input: { run, step: 'dig' }, task: { request_key: 'r1' } }, connection());
  assert.equal(began.code, 0, began.stderr + began.out);
  assert.equal(began.last.result.lane_jobs.length, 6);
  await finish(step, lane => `ai:alone`);
  const alone = await runRowIn(hand, { input: { run, step: 'dig', answer: answerFor(step) }, task: { request_key: 'r3' } }, connection());
  assert.notEqual(alone.code, 0);
  assert.match(alone.last.error, /fails/);
  await finish(step);
  const handed = await runRowIn(hand, { input: { run, step: 'dig', answer: answerFor(step) }, task: { request_key: 'r2' } }, connection());
  assert.equal(handed.code, 0, handed.stderr + handed.out);
  assert.equal(handed.last.result.status, 'kept');
});

test('each lane is handed its own AI id and the exact commands to take and finish its job under it', async () => {
  const step = stepOf({ agents: 6 });
  await startRun([step]);
  const began = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
  const ids = began.lane_jobs.map(item => item.as);
  assert.equal(new Set(ids).size, 6, 'six lanes, six different ids');
  for (const item of began.lane_jobs) {
    assert.match(item.as, /^ai:[a-z0-9-]+$/);
    assert.equal(item.take, `trillion take ${item.job} --as ${item.as}`);
    assert.equal(item.plan, `trillion plan ${item.job} --acceptance-file ACCEPTANCE.json --as ${item.as}`);
    assert.equal(item.finish, `trillion finish ${item.job} "<result>" --check-file CHECK.json --as ${item.as}`);
    const laneJob = await jobRow(item.job);
    assert.equal(laneJob.take_as, item.as, 'the lane job row carries it too');
    assert.ok(laneJob.lane_note.includes(item.take));
  }
  // the same start again hands the same ids, and another run's lane never shares one
  assert.deepEqual((await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b2' } }, { sql: db.sql })).lane_jobs.map(item => item.as), ids);
  assert.notEqual(laneAiId('ai-job:workflow:made-up-dig:k2', 'dig-1'), laneAiId(run, 'dig-1'));
  assert.equal(laneCommands(run, 'dig', 'dig-1').as, ids[0]);
  assert.deepEqual((await startARecipeStep({ input: { run, step: 'nothing-here' }, task: { request_key: 'b3' } }, { sql: db.sql }).catch(() => 'refused')), 'refused');
});

test('lanes that take their jobs by the commands handed back are six workers to the submit check', async () => {
  const step = stepOf({ agents: 6 });
  await startRun([step]);
  const began = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
  for (const item of began.lane_jobs) await patchJob(item.job, { status: 'done', finished_by: item.as });
  assert.equal((await submit({ run, step: 'dig', answer: answerFor(step) })).status, 'kept');
});

test('an answer that breaks the step\'s submit schema is refused naming each bad field, and nothing is kept; a well-formed one is kept', async () => {
  const submitSchema = {
    type: 'object', required: ['branches'], additionalProperties: false,
    properties: { branches: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'kind'], properties: { id: { type: 'string', minLength: 1 }, kind: { enum: ['yes', 'no'] } } } } },
  };
  const step = stepOf({ id: 'pick', agents: 1, checks: [], submit: submitSchema });
  await startRun([step]);
  const before = await count();
  const malformed = { branches: [{ id: 'a', kind: 'maybe' }, { kind: 'yes' }], extra: 1 };
  await assert.rejects(submit({ run, step: 'pick', answer: malformed }), error => {
    for (const part of ['this.branches[0].kind', 'this.branches[1].id', 'this.extra']) assert.ok(error.message.includes(part), `${part} in: ${error.message}`);
    return true;
  });
  await assert.rejects(submit({ run, step: 'pick', answer: { branches: 'nope' } }), /this\.branches must be array, is string/);
  assert.equal(await jobRow(answerId(run, 'pick')) !== null, false);
  assert.equal(await count(), before);
  const kept = await submit({ run, step: 'pick', answer: { branches: [{ id: 'a', kind: 'yes' }] } });
  assert.equal(kept.status, 'kept');
  assert.equal(await jobRow(answerId(run, 'pick')) !== null, true);
});
