// tools/workflows: how many agents run a step is one number with two places to say it. The step row's `agents` is the
// default every run gets; the run's input `agents_per_step` under the step's id overrides it for that run. The starter,
// the step start and the submit read the step the same way (runStep), so the lanes started are the lanes judged. Every
// recipe here is made up; no number below is known to the code.
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { laneIds, laneJobId, runStep } from '../read-data/step-agents.mjs';
import { startARecipeStep } from '../read-data/start-a-recipe-step.mjs';
import { submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';
import { readRow, startDatabase } from '../test-helpers/rows-in-sql.mjs';

const laneCheck = { kind: 'lane-jobs', path: ['this', 'lanes'], lane: 'id', job: 'job', says: 'Every lane comes from its own job that ran' };
const stepOf = (extra = {}) => ({ id: 'dig', title: 'Dig', do: 'Dig in your lane.', submit: { type: 'object' }, checks: [laneCheck], ...extra });
const run = 'ai-job:workflow:made-up-dig:k1';

let db;
before(async () => { db = await startDatabase(); });
after(async () => { await db.stop(); });
beforeEach(async () => { await db.reset(); });

const setJob = (id, value) => db.sql('insert into ai_job (id, value) values ($1, $2::jsonb) on conflict (id) do update set value = excluded.value', [id, JSON.stringify(value)]);
const patchJob = async (id, patch) => setJob(id, { ...(await readRow(db.sql, 'ai_job', id)), ...patch });
const startRun = (steps, input) => setJob(run, { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-dig', label: 'Made-up dig', job: steps, input });

test('the row number is the default and the run input overrides it', () => {
  assert.equal(runStep(stepOf({ agents: 3 }), {}).agents, 3);
  assert.equal(runStep(stepOf({ agents: 3 }), { agents_per_step: { other: 9 } }).agents, 3);
  assert.equal(runStep(stepOf({ agents: 3 }), { agents_per_step: { dig: 7 } }).agents, 7);
  assert.equal(runStep(stepOf(), { agents_per_step: { dig: 10000 } }).agents, 10000);
  assert.equal(runStep(stepOf({ agents: 4 }), { agents_per_step: { dig: 1 } }).agents, 1);
  assert.deepEqual(laneIds(runStep(stepOf({ agents: 2 }), { agents_per_step: { dig: 4 } })), ['dig-1', 'dig-2', 'dig-3', 'dig-4']);
});

test('an override that is not a whole number, or meets named lanes or a step with no lane-jobs check, is refused', () => {
  for (const bad of [0, -2, 1.5, '6', null]) assert.throws(() => runStep(stepOf(), { agents_per_step: { dig: bad } }), /whole number/, String(bad));
  assert.throws(() => runStep(stepOf({ agents: 2, lanes: ['north', 'south'] }), { agents_per_step: { dig: 5 } }), /names its lanes/);
  assert.throws(() => runStep(stepOf({ lanes_from: ['steps', 'split', 'parts', '*', 'id'] }), { agents_per_step: { dig: 5 } }), /names its lanes/);
  assert.throws(() => runStep(stepOf({ checks: [] }), { agents_per_step: { dig: 5 } }), /no lane-jobs check/);
  assert.equal(runStep(stepOf({ checks: [] }), { agents_per_step: { dig: 1 } }).agents, 1);
});

test('a run that overrides the row starts that many lanes, and its submit judges exactly those lanes', async () => {
  const step = stepOf({ agents: 2 });
  await startRun([step], { topic: 'made up', agents_per_step: { dig: 5 } });
  const began = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
  assert.equal(began.status, 'written');
  assert.equal(began.lane_jobs.length, 5);
  const lanes = began.lane_jobs.map(item => item.lane);
  const submit = answer => submitARecipeStep({ input: { run, step: 'dig', answer }, task: { request_key: 's1' } }, { sql: db.sql });
  for (const lane of lanes.slice(0, 2)) await patchJob(laneJobId(run, 'dig', lane), { status: 'done', finished_by: `ai:taker-${lane}` });
  // The row's two lanes alone no longer pass: the run asked for five.
  await assert.rejects(submit({ lanes: lanes.slice(0, 2).map(id => ({ id, job: laneJobId(run, 'dig', id) })) }), /fails/);
  for (const lane of lanes) await patchJob(laneJobId(run, 'dig', lane), { status: 'done', finished_by: `ai:taker-${lane}` });
  const kept = await submit({ lanes: lanes.map(id => ({ id, job: laneJobId(run, 'dig', id) })) });
  assert.equal(kept.status, 'kept');
});

test('a run with no override keeps the row number', async () => {
  await startRun([stepOf({ agents: 3 })], { topic: 'made up' });
  const began = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { sql: db.sql });
  assert.equal(began.lane_jobs.length, 3);
});
