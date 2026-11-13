// tools/workflows: the tools the run's AI uses to go through a recipe run's steps. Beginning a step starts its lane jobs
// itself when the step has several agents; handing in a step's answer builds the `ran-job` catalog from each lane's own
// ai-job and takes no catalog from the caller. Every recipe here is made up; no number below is known to the code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { laneIds, laneJobId } from '../read-data/step-agents.mjs';
import { startARecipeStep } from '../read-data/start-a-recipe-step.mjs';
import { answerId, submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';

const laneCheck = { kind: 'lane-jobs', path: ['this', 'lanes'], lane: 'id', job: 'job', says: 'Every lane comes from its own job that ran' };
const stepOf = (extra = {}) => ({ id: 'dig', title: 'Dig', do: 'Dig in your lane.', submit: { type: 'object' }, checks: [laneCheck], ...extra });
const run = 'ai-job:workflow:made-up-dig:k1';

function memoryDoor(steps, input = { topic: 'made up' }) {
  const held = new Map([[run, { id: run, value: { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-dig', label: 'Made-up dig', job: steps, input } }]]);
  const writes = [];
  return {
    held, writes,
    read: async (_kind, id) => held.get(id)?.value ?? null,
    async *list() {},
    write: async (records, { key } = {}) => { writes.push({ key, count: records.length }); for (const record of records) held.set(record.id, record); },
  };
}
const finish = (door, step, taker = lane => `ai:taker-of-${lane}`) => {
  for (const lane of laneIds(step)) door.held.get(laneJobId(run, step.id, lane)).value = { ...door.held.get(laneJobId(run, step.id, lane)).value, status: 'done', finished_by: taker(lane) };
};
const answerFor = step => ({ lanes: laneIds(step).map(id => ({ id, job: laneJobId(run, step.id, id) })) });
const submit = (door, input, key = 's1') => submitARecipeStep({ input, task: { request_key: key } }, { door });

test('beginning a step with several agents starts its lane jobs in the same call, and hands back the step and the lanes', async () => {
  for (const agents of [2, 6, 40]) {
    const step = stepOf({ agents });
    const door = memoryDoor([step]);
    const began = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { door });
    assert.equal(began.status, 'written');
    assert.equal(began.step.id, 'dig');
    assert.deepEqual(began.lane_jobs, laneIds(step).map(lane => ({ lane, job: laneJobId(run, 'dig', lane) })));
    assert.ok(began.lane_jobs.every(({ job }) => door.held.get(job).value.status === 'waiting'), `${agents} agents`);
  }
});

test('beginning a step with one agent starts nothing, and beginning twice changes nothing', async () => {
  const door = memoryDoor([stepOf({ id: 'plain', checks: [] }), stepOf({ agents: 3 })]);
  const plain = await startARecipeStep({ input: { run, step: 'plain' }, task: { request_key: 'b1' } }, { door });
  assert.deepEqual([plain.status, plain.lane_jobs], ['one-agent', []]);
  assert.equal(door.writes.length, 0);
  const first = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b2' } }, { door });
  const writes = door.writes.length;
  const again = await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b3' } }, { door });
  assert.equal(again.status, 'already-there');
  assert.deepEqual(again.lane_jobs, first.lane_jobs);
  assert.equal(door.writes.length, writes);
  await assert.rejects(startARecipeStep({ input: { run, step: 'nothing' }, task: { request_key: 'b4' } }, { door }), /no step "nothing"/);
});

test('an answer is kept when every lane\'s own job is done by a different taker, and only then', async () => {
  const step = stepOf({ agents: 6 });
  const door = memoryDoor([step]);
  await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { door });
  await assert.rejects(submit(door, { run, step: 'dig', answer: answerFor(step) }), /fails/, 'no lane job has run yet');
  assert.equal(door.held.has(answerId(run, 'dig')), false);
  finish(door, step);
  const kept = await submit(door, { run, step: 'dig', answer: answerFor(step) });
  assert.equal(kept.status, 'kept');
  assert.deepEqual(kept.checks.map(check => check.kind), ['lane-jobs']);
  assert.deepEqual(door.held.get(answerId(run, 'dig')).value.answer, answerFor(step));
  const again = await submit(door, { run, step: 'dig', answer: { lanes: [] } }, 's2');
  assert.equal(again.status, 'already-there');
  assert.deepEqual(door.held.get(answerId(run, 'dig')).value.answer, answerFor(step), 'the first answer stays');
});

test('one AI finishing the six lane jobs does not pass, nor does a lane job started but not finished', async () => {
  const step = stepOf({ agents: 6 });
  const door = memoryDoor([step]);
  await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { door });
  finish(door, step, () => 'ai:one-worker');
  await assert.rejects(submit(door, { run, step: 'dig', answer: answerFor(step) }), /fails/);
  finish(door, step);
  const waiting = laneJobId(run, 'dig', laneIds(step)[5]);
  door.held.get(waiting).value = { ...door.held.get(waiting).value, status: 'waiting', finished_by: undefined };
  await assert.rejects(submit(door, { run, step: 'dig', answer: answerFor(step) }), new RegExp(laneIds(step)[5]));
  assert.equal(door.held.has(answerId(run, 'dig')), false);
});

test('a caller cannot give a catalog, or anything else the checks would take on its word', async () => {
  const step = stepOf({ agents: 2 });
  const door = memoryDoor([step]);
  await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { door });
  for (const extra of [{ catalogs: { 'ran-job': () => 'ai:x' } }, { catalog: { x: 'ai:y' } }, { ran: ['a'] }, { takers: {} }]) {
    await assert.rejects(submit(door, { run, step: 'dig', answer: answerFor(step), ...extra }), /is not taken/, JSON.stringify(Object.keys(extra)));
  }
  assert.equal(door.held.has(answerId(run, 'dig')), false);
});

test('a job of an invented lane or of another step cannot stand in: only the run\'s own lane jobs are read', async () => {
  const step = stepOf({ agents: 2 });
  const door = memoryDoor([step]);
  await startARecipeStep({ input: { run, step: 'dig' }, task: { request_key: 'b1' } }, { door });
  finish(door, step);
  door.held.set('ai-job:other', { id: 'ai-job:other', value: { kind: 'ai-job', status: 'done', finished_by: 'ai:third' } });
  const bent = { lanes: [{ id: 'dig-1', job: laneJobId(run, 'dig', 'dig-1') }, { id: 'dig-2', job: 'ai-job:other' }] };
  await assert.rejects(submit(door, { run, step: 'dig', answer: bent }), /fails/);
});

test('a later step reads the answers kept for earlier steps, and cannot be handed in before them', async () => {
  const first = stepOf({ id: 'scope', checks: [], submit: { type: 'object' } });
  const second = stepOf({ id: 'plan', checks: [{ kind: 'subset-of', path: ['this', 'topics'], of: ['steps', 'scope', 'topics'], says: 'Plan only what scope named' }] });
  const door = memoryDoor([first, second]);
  await assert.rejects(submit(door, { run, step: 'plan', answer: { topics: ['a'] } }), /Step "scope" has no answer kept/);
  await submit(door, { run, step: 'scope', answer: { topics: ['a', 'b'] } });
  await assert.rejects(submit(door, { run, step: 'plan', answer: { topics: ['c'] } }), /fails/);
  assert.equal((await submit(door, { run, step: 'plan', answer: { topics: ['a'] } }, 's3')).status, 'kept');
});

test('a check this tool cannot judge is listed as unchecked, never as passed', async () => {
  const step = stepOf({ checks: [{ kind: 'exists', catalog: 'tool', path: ['this', 'tool'], says: 'The tool is real' }] });
  const door = memoryDoor([step]);
  const kept = await submit(door, { run, step: 'dig', answer: { tool: 'tool:x' } });
  assert.equal(kept.status, 'kept');
  assert.deepEqual(kept.checks, []);
  assert.equal(kept.unchecked.length, 1);
});

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
test('the shipped rows declare only ai-job read and write, take only run, step and answer, and run as their rows do', async () => {
  const begin = rowOf(rows, 'tool:start-a-recipe-step'), hand = rowOf(rows, 'tool:submit-a-recipe-step');
  for (const row of [begin, hand]) assert.deepEqual(row.invoke.records.rights, [{ kind: 'ai-job', operations: ['records:read', 'records:write'] }]);
  assert.equal(hand.input_schema.additionalProperties, false);
  assert.deepEqual(Object.keys(hand.input_schema.properties).sort(), ['answer', 'run', 'step']);
  const step = stepOf({ agents: 6 });
  const parent = { id: run, type: 'ai-job', value: { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-dig', label: 'Made-up dig', job: [step], input: {} } };
  const began = await answerOf(begin, { run, step: 'dig' }, { task: { request_key: 'r1' }, records: [parent] });
  assert.equal(began.status, 0, began.error);
  assert.equal(began.result.lane_jobs.length, 6);
  const finished = began.kept.map(record => (record.id === run ? record : { ...record, value: { ...record.value, status: 'done', finished_by: `ai:${record.id}` } }));
  const handed = await answerOf(hand, { run, step: 'dig', answer: answerFor(step) }, { task: { request_key: 'r2' }, records: finished });
  assert.equal(handed.status, 0, handed.error);
  assert.equal(handed.result.status, 'kept');
  const alone = await answerOf(hand, { run, step: 'dig', answer: answerFor(step) }, { task: { request_key: 'r3' }, records: began.kept.map(record => (record.id === run ? record : { ...record, value: { ...record.value, status: 'done', finished_by: 'ai:one' } })) });
  assert.notEqual(alone.status, 0);
  assert.match(alone.error ?? alone.stderr ?? '', /fails/);
});
