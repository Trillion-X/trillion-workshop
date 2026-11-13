// tools/workflows: a step's `agents` is one whole number on the step row. The engine starts that many jobs for the step,
// each with its own lane id from the step's own data, and the step's lane-jobs check refuses a submit unless every lane's
// findings name a distinct job that ran. Every recipe here is made up; no number below is known to the code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentProblems, agentsOf, laneIds, laneJobId } from '../read-data/step-agents.mjs';
import { startAStepsAgents } from '../read-data/start-a-steps-agents.mjs';
import { checkResults } from '../read-data/recipe-check-results.mjs';
import { recipeFromRows } from '../read-data/recipe-rows.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';

const submit = { type: 'object', required: ['lanes'], properties: { lanes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, job: { type: 'string' } } } } } };
const laneCheck = { kind: 'lane-jobs', path: ['this', 'lanes'], lane: 'id', job: 'job', says: 'Every lane comes from its own job that ran' };
const stepOf = (extra = {}) => ({ id: 'dig', title: 'Dig', do: 'Dig in your lane.', submit, checks: [laneCheck], ...extra });
const recipeOf = steps => ({ kind: 'workflow-recipe', id: 'workflow:made-up-dig', label: 'Made-up dig', job: 'Dig somewhere made up.', steps });

// A records door that holds ai-job records in memory and counts the writes it was given.
function memoryDoor(seed = []) {
  const held = new Map(seed.map(record => [record.id, record]));
  const writes = [];
  return {
    held, writes,
    read: async (_kind, id) => held.get(id)?.value ?? null,
    async *list() {},
    write: async (records, { key } = {}) => { writes.push({ key, count: records.length }); for (const record of records) held.set(record.id, record); },
  };
}
const runWith = async (steps, request_key = 'k1') => {
  const door = memoryDoor();
  const recipe = recipeOf(steps);
  door.held.set('record:workflow-recipe:made-up-dig', { id: 'record:workflow-recipe:made-up-dig', value: { recipe: recipe.id, title: recipe.label, job: recipe.job } });
  const run = `ai-job:${recipe.id}:${request_key}`;
  door.held.set(run, { id: run, type: 'ai-job', value: { kind: 'ai-job', status: 'waiting', row: recipe.id, label: recipe.label, job: steps, input: { topic: 'made up' } } });
  return { door, run };
};

test('agents is one whole number on the step, 1 when left out', () => {
  assert.equal(agentsOf({ id: 'a' }), 1);
  assert.equal(agentsOf({ id: 'a', agents: 6 }), 6);
  assert.equal(agentsOf({ id: 'a', agents: 10000 }), 10000);
  for (const bad of [0, -1, 1.5, '6', null, NaN]) assert.throws(() => agentsOf({ id: 'a', agents: bad }), /agents/, String(bad));
});

test('a lane id comes from the step\'s own data: its lanes when it lists them, else its id and the lane\'s place', () => {
  assert.deepEqual(laneIds({ id: 'dig', agents: 3 }), ['dig-1', 'dig-2', 'dig-3']);
  assert.deepEqual(laneIds({ id: 'dig', agents: 2, lanes: ['north', 'south'] }), ['north', 'south']);
  assert.deepEqual(laneIds({ id: 'dig' }), ['dig-1']);
  assert.equal(laneJobId('ai-job:workflow:x:k', 'dig', 'north'), 'ai-job:workflow:x:k:dig:north');
});

test('the validator names a bad agents number, lanes that do not match it, and a fanned step with no lane-jobs check', () => {
  assert.deepEqual(recipeProblems(recipeOf([stepOf({ agents: 6 })])), []);
  assert.deepEqual(recipeProblems(recipeOf([stepOf({ agents: 1, checks: [] })])), []);
  assert.match(recipeProblems(recipeOf([stepOf({ agents: 0 })])).join('\n'), /agents must be a whole number/);
  assert.match(recipeProblems(recipeOf([stepOf({ agents: 1.5 })])).join('\n'), /agents must be a whole number/);
  assert.match(recipeProblems(recipeOf([stepOf({ agents: 3, lanes: ['a', 'b'] })])).join('\n'), /lanes must list exactly 3/);
  assert.match(recipeProblems(recipeOf([stepOf({ agents: 3, lanes: ['a', 'b', 'a'] })])).join('\n'), /lanes must list exactly 3 different/);
  assert.match(recipeProblems(recipeOf([stepOf({ agents: 6, checks: [] })])).join('\n'), /needs a lane-jobs check/);
  assert.deepEqual(agentProblems({ id: 'x', agents: 2, lanes: ['a', 'b'] }, 'steps[0]'), []);
});

test('step rows carry agents and lanes into the recipe', () => {
  const row = { value: { recipe: 'workflow:made-up-dig', title: 'Made-up dig', job: 'Dig.' } };
  const step = { value: { step: 'dig', title: 'Dig', position: 1, do: 'Dig.', submit: JSON.stringify(submit), checks: JSON.stringify([laneCheck]), agents: 2, lanes: '["north","south"]' } };
  const [made] = recipeFromRows(row, [step]).steps;
  assert.equal(made.agents, 2);
  assert.deepEqual(made.lanes, ['north', 'south']);
  assert.equal(recipeFromRows(row, [{ value: { ...step.value, agents: undefined, lanes: undefined } }]).steps[0].agents, undefined);
});

const ranAll = { catalogs: { 'ran-job': () => true } };
const answer = (step, jobOf = lane => `ai-job:workflow:made-up-dig:k1:dig:${lane}`) => ({ lanes: laneIds(step).map(id => ({ id, job: jobOf(id) })) });
const judge = (step, output, options = ranAll) => checkResults(step, { this: output, input: {}, steps: {}, run: 'ai-job:workflow:made-up-dig:k1' }, options).find(result => result.kind === 'lane-jobs');

test('lane-jobs passes when every lane names its own job that ran, at any number', () => {
  for (const agents of [2, 6, 40]) {
    const step = stepOf({ agents });
    assert.equal(judge(step, answer(step)).passed, true, `${agents} agents`);
  }
});

test('one job cannot stand for six lanes', () => {
  const step = stepOf({ agents: 6 });
  const one = 'ai-job:workflow:made-up-dig:k1:dig:dig-1';
  const result = judge(step, answer(step, () => one));
  assert.equal(result.passed, false);
  assert.ok(result.failing.length > 0);
});

test('a missing lane, a repeated lane id, a lane id the step does not hold and a job of another step or run all fail', () => {
  const step = stepOf({ agents: 3 });
  const full = answer(step);
  assert.equal(judge(step, { lanes: full.lanes.slice(0, 2) }).passed, false, 'a lane is missing');
  assert.equal(judge(step, { lanes: [full.lanes[0], full.lanes[0], full.lanes[1]] }).passed, false, 'a lane id twice');
  assert.equal(judge(step, { lanes: [...full.lanes.slice(0, 2), { id: 'stranger', job: 'ai-job:workflow:made-up-dig:k1:dig:stranger' }] }).passed, false, 'a lane the step does not hold');
  assert.equal(judge(step, { lanes: [...full.lanes.slice(0, 2), { id: 'dig-3', job: 'ai-job:workflow:made-up-dig:k1:other:dig-3' }] }).passed, false, 'a job of another step');
  assert.equal(judge(step, { lanes: [...full.lanes.slice(0, 2), { id: 'dig-3', job: 'ai-job:workflow:made-up-dig:k2:dig:dig-3' }] }).passed, false, 'a job of another run');
});

test('a lane whose job did not run fails, and with no way to look jobs up the check is not evaluated, never passed', () => {
  const step = stepOf({ agents: 2 });
  const notRan = judge(step, answer(step), { catalogs: { 'ran-job': job => !job.endsWith('dig-2') } });
  assert.equal(notRan.passed, false);
  assert.deepEqual(notRan.failing, ['dig-2']);
  const blind = judge(step, answer(step), {});
  assert.equal(blind.evaluated, false);
  assert.equal(blind.passed, undefined);
});

test('a step with one agent has nothing to fan out and the check holds with one lane', () => {
  const step = stepOf({});
  assert.equal(judge(step, answer(step)).passed, true);
});

test('starting a step\'s agents writes that many waiting jobs, each with its own lane, and nothing for a step with one agent', async () => {
  for (const agents of [6, 3]) {
    const step = stepOf({ agents });
    const { door, run } = await runWith([step, stepOf({ id: 'plain', checks: [] })]);
    // the run job was made from these steps; start the first step's agents
    door.held.get(run).value.job = [{ ...step }, stepOf({ id: 'plain', checks: [] })];
    const done = await startAStepsAgents({ input: { run, step: 'dig' }, task: { request_key: 'fan-1' } }, { door });
    assert.equal(done.status, 'written');
    assert.equal(done.jobs.length, agents);
    assert.deepEqual(done.jobs, laneIds(step).map(lane => laneJobId(run, 'dig', lane)));
    const jobs = done.jobs.map(id => door.held.get(id).value);
    assert.ok(jobs.every(job => job.status === 'waiting' && job.kind === 'ai-job' && job.step === 'dig' && job.of === agents && job.parent === run));
    assert.deepEqual(jobs.map(job => job.lane), laneIds(step));
    assert.equal(new Set(done.jobs).size, agents);
    const plain = await startAStepsAgents({ input: { run, step: 'plain' }, task: { request_key: 'fan-2' } }, { door });
    assert.deepEqual(plain, { jobs: [], status: 'one-agent' });
  }
});

test('the same step started again finds its jobs and changes none, even one an AI already finished', async () => {
  const step = stepOf({ agents: 4 });
  const { door, run } = await runWith([step]);
  const first = await startAStepsAgents({ input: { run, step: 'dig' }, task: { request_key: 'a' } }, { door });
  door.held.get(first.jobs[2]).value.status = 'done';
  const writes = door.writes.length;
  const again = await startAStepsAgents({ input: { run, step: 'dig' }, task: { request_key: 'b' } }, { door });
  assert.equal(again.status, 'already-there');
  assert.deepEqual(again.jobs, first.jobs);
  assert.equal(door.writes.length, writes);
  assert.equal(door.held.get(first.jobs[2]).value.status, 'done');
});

test('a large number is only a number: ten thousand agents are written in batches that each fit the door', async () => {
  const step = stepOf({ agents: 10000 });
  const { door, run } = await runWith([step]);
  const done = await startAStepsAgents({ input: { run, step: 'dig' }, task: { request_key: 'big' } }, { door, most_writes: 256 });
  assert.equal(done.jobs.length, 10000);
  assert.equal(new Set(done.jobs).size, 10000);
  assert.ok(door.writes.every(write => write.count <= 256));
  assert.equal(door.writes.reduce((sum, write) => sum + write.count, 0), 10000);
  assert.equal(new Set(door.writes.map(write => write.key)).size, door.writes.length, 'each batch has its own request key');
});

test('a step the run does not hold, or a run that is not there, writes nothing and says so', async () => {
  const { door, run } = await runWith([stepOf({ agents: 2 })]);
  await assert.rejects(startAStepsAgents({ input: { run, step: 'nothing' }, task: { request_key: 'x' } }, { door }), /no step "nothing"/);
  await assert.rejects(startAStepsAgents({ input: { run: 'ai-job:workflow:nope:k', step: 'dig' }, task: { request_key: 'x' } }, { door }), /no run/);
  assert.equal(door.writes.length, 0);
});

// The shipped row, run the way the container runs it, against the fake records door with exactly the row's rights.
test('tool:start-a-steps-agents, run as its row, writes one waiting job per lane of a six-agent step and none twice', async () => {
  const { readFileSync } = await import('node:fs');
  const { answerOf, rowOf } = await import('../../../test-helpers/run-a-row.mjs');
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
  const starter = rowOf(rows, 'tool:start-a-steps-agents');
  assert.deepEqual(starter.invoke.records.rights, [{ kind: 'ai-job', operations: ['records:read', 'records:write'] }]);
  const step = stepOf({ agents: 6 });
  const run = 'ai-job:workflow:made-up-dig:k1';
  const parent = { id: run, type: 'ai-job', value: { kind: 'ai-job', status: 'taken', row: 'workflow:made-up-dig', label: 'Made-up dig', job: [step], input: { topic: 'made up' } } };
  const ran = await answerOf(starter, { run, step: 'dig' }, { task: { request_key: 'fan-1' }, records: [parent] });
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.status, 'written');
  assert.deepEqual(ran.result.jobs, laneIds(step).map(lane => laneJobId(run, 'dig', lane)));
  const lanes = ran.kept.filter(record => record.id !== run);
  assert.equal(lanes.length, 6);
  assert.ok(lanes.every(record => record.value.status === 'waiting' && record.value.parent === run));
  const again = await answerOf(starter, { run, step: 'dig' }, { task: { request_key: 'fan-2' }, records: ran.kept });
  assert.equal(again.result.status, 'already-there');
});
