// A step's checks run as ordinary engine steps (a `return` step judging each rule by its kind row's bindings, and a
// `fail` step naming what breaks), and they judge every answer as the engine's own check step did. The rules each case
// expects to fail are the ones the older check step (workflow-core executor/checks.rs) failed for the same answer, run
// on the built engine on Nov 17 2026 before that step was deleted. Made-up values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAWorkflow, workflowEngine } from '../read-data/run-a-workflow.mjs';
import { definitionOf } from '../read-data/workflows.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const recipeWith = checks => ({
  id: 'workflow:made-up-checked', title: 'Checked', job: 'Answer one step.',
  steps: [{ id: 'answer', do: 'Answer.', submit: { type: 'object' }, checks }, { id: 'after', do: 'Then this.', submit: { type: 'object' } }],
});

// The rules a refusal names, in the order they are given.
const failing = (message, checks) => checks.map(check => check.says).filter(says => message?.includes(`${says} (`));

// [name, checks, input, [answer, the rules the older check step failed]]
const cases = [
  ['subset-of', [{ kind: 'subset-of', says: 'Only allowed', path: ['this', 'picked', '*'], of: ['input', 'allowed'] }], { allowed: ['a', 'b', 'c'] },
    [[{ picked: ['a', 'b'] }, []], [{ picked: ['a', 'z'] }, ['Only allowed']], [{ picked: [] }, []], [{ picked: [' a '] }, []]]],
  ['subset-of over two paths', [{ kind: 'subset-of', says: 'Only either list', path: ['this', 'picked', '*'], of: [['input', 'one'], ['input', 'two']] }], { one: ['a'], two: ['b'] },
    [[{ picked: ['a', 'b'] }, []], [{ picked: ['c'] }, ['Only either list']]]],
  ['covers', [{ kind: 'covers', says: 'Every one named', path: ['this', 'named', '*'], of: ['input', 'need'] }], { need: ['a', 'c'] },
    [[{ named: ['a', 'b', 'c'] }, []], [{ named: ['a'] }, ['Every one named']]]],
  ['covers values', [{ kind: 'covers', says: 'Has both', path: ['this', 'named', '*'], values: ['x', 'y'] }], {},
    [[{ named: ['y', 'x'] }, []], [{ named: ['x'] }, ['Has both']]]],
  ['mentioned-in', [{ kind: 'mentioned-in', says: 'Each is in the notes', path: ['this', 'names', '*'], in: ['input', 'notes'] }], { notes: ['We play Tennis daily', 'a walk'] },
    [[{ names: ['tennis', 'WALK'] }, []], [{ names: ['golf'] }, ['Each is in the notes']]]],
  ['excludes-words', [{ kind: 'excludes-words', says: 'No advice words', path: ['this', 'lines', '*'], words: ['should', 'Must'] }], {},
    [[{ lines: ['a calm line'] }, []], [{ lines: ['you MUST go', 'fine'] }, ['No advice words']]]],
  ['distinct-at-least', [{ kind: 'distinct-at-least', says: 'Three kinds', path: ['this', 'kinds', '*'], count: 3 }], {},
    [[{ kinds: ['a', 'b', 'c', 'a'] }, []], [{ kinds: ['a', 'a', 'b'] }, ['Three kinds']]]],
  ['two rules', [
    { kind: 'subset-of', says: 'Only allowed', path: ['this', 'picked', '*'], of: ['input', 'allowed'] },
    { kind: 'distinct-at-least', says: 'Two picks', path: ['this', 'picked', '*'], count: 2 },
  ], { allowed: ['a', 'b'] },
    [[{ picked: ['a', 'b'] }, []], [{ picked: ['a'] }, ['Two picks']], [{ picked: ['z'] }, ['Only allowed', 'Two picks']]]],
];

const judged = async (checks, input, answer, host = null) => {
  if (!host) return (await runAWorkflow({ recipe: recipeWith(checks), input, answers: { answer, after: { done: true } } })).run;
  const definition = definitionOf(recipeWith(checks));
  return makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition({ definitions: [definition, ...(definition.uses ?? [])], workflow_id: definition.id, input, answers: { answer, after: { done: true } } }, host);
};

const holdsAsBefore = async (name, checks, input, answers, host) => {
  for (const [answer, failed] of answers) {
    const run = await judged(checks, input, answer, host);
    const label = `${name} ${JSON.stringify(answer)}: ${run.error_message ?? ''}`;
    assert.equal(run.status, failed.length ? 'failed' : 'completed', label);
    assert.deepEqual(failing(run.error_message, checks), failed, label);
  }
};

for (const [name, checks, input, answers] of cases) {
  test(`${name}: the steps judge each answer as the older check step did`, () => holdsAsBefore(name, checks, input, answers));
}

// Checks that look things up: each lookup asks its catalog's reader (recipe-check-kinds.json), here a host that answers
// the workflow catalog's SQL from made-up rows; a catalog with no reader is refused when the workflow is made.
const kept = ['workflow:made-up-a', 'workflow:made-up-b'];
const asked = [];
// The host answers the reader's tool; every other ask (the checked step and the one after it) is answered as the run's
// own answers say, read from the step id in its context.
const hostFor = (answer, reader = null) => ({
  read: async () => { throw new Error('a lookup asks its reader, never a bare read'); },
  ask: async (name, payload, context) => {
    const input = JSON.parse(new TextDecoder().decode(payload));
    if (name !== 'tool:run-sql-in-my-database') {
      const { step_id: step } = JSON.parse(new TextDecoder().decode(context));
      return new TextEncoder().encode(JSON.stringify(step === 'answer' ? answer : { done: true }));
    }
    if (reader) return reader(input);
    asked.push({ name, database: input.database });
    const rows = kept.includes(input.params[0]) ? [{ id: input.params[0] }] : [];
    return new TextEncoder().encode(JSON.stringify({ columns: ['id'], rows, row_count: rows.length }));
  },
});
const exists = [{ kind: 'exists', says: 'Each workflow exists', path: ['this', 'workflows', '*'], catalog: 'workflow' }];
const keptIn = { kept_in: { database: 'made_up_for_who_runs_it' } };

test('exists: each value is looked up by its catalog\'s reader, in the database the row was kept in', async () => {
  for (const [answer, failed] of [
    [{ workflows: ['workflow:made-up-a', 'workflow:made-up-b'] }, []],
    [{ workflows: ['workflow:made-up-a', 'workflow:made-up-z'] }, ['Each workflow exists']],
    [{ workflows: [] }, []],
  ]) {
    const run = await judged(exists, keptIn, answer, hostFor(answer));
    assert.equal(run.status, failed.length ? 'failed' : 'completed', `${JSON.stringify(answer)}: ${run.error_message ?? ''}`);
    assert.deepEqual(failing(run.error_message, exists), failed);
  }
  assert.ok(asked.length && asked.every(call => call.name === 'tool:run-sql-in-my-database' && call.database === 'made_up_for_who_runs_it'));
  const run = await judged(exists, keptIn, { workflows: ['workflow:made-up-z'] }, hostFor({ workflows: ['workflow:made-up-z'] }));
  assert.match(run.error_message, /Each workflow exists \("workflow:made-up-z"\)/);
});

test('exists: a reader that fails counts its value as not found', async () => {
  const answer = { workflows: ['workflow:made-up-a'] };
  const run = await judged(exists, keptIn, answer, hostFor(answer, () => { throw new Error('the database is not reachable'); }));
  assert.equal(run.status, 'failed');
  assert.match(run.error_message, /Each workflow exists \("workflow:made-up-a"\)/);
});

test('a catalog with no reader yet is read at its address, as before readers', async () => {
  const rows = { 'list-row': { 'drafts/one': {} } };
  const check = [{ kind: 'exists', says: 'Each draft is a row', path: ['this', 'rows', '*'], catalog: 'list-row' }];
  const byAddress = answer => ({ ...hostFor(answer), read: async from => {
    const { catalog, id } = JSON.parse(from);
    if (!rows[catalog]?.[id]) throw new Error(`no ${catalog} ${id}`);
    return new TextEncoder().encode(JSON.stringify(rows[catalog][id]));
  } });
  const held = await judged(check, {}, { rows: ['drafts/one'] }, byAddress({ rows: ['drafts/one'] }));
  assert.equal(held.status, 'completed', held.error_message ?? '');
  const missing = await judged(check, {}, { rows: ['drafts/one', 'drafts/two'] }, byAddress({ rows: ['drafts/one', 'drafts/two'] }));
  assert.match(missing.error_message, /Each draft is a row \("drafts\/two"\)/);
});

// Lane jobs look things up by address: a host answers each read ({"catalog", "id"} → the thing, or a refusal).
const known = { tool: { 'tool:made-up-a': {}, 'tool:made-up-b': {} }, 'ran-job': { 'job-north': { taker: 'ai:one' }, 'job-south': { taker: 'ai:two' }, 'job-east': { taker: 'ai:one' } } };
const host = { read: async from => {
  const { catalog, id } = JSON.parse(from);
  const found = known[catalog]?.[id];
  if (!found) throw new Error(`no ${catalog} ${id}`);
  return new TextEncoder().encode(JSON.stringify(found));
} };
const laneJobs = { kind: 'lane-jobs', says: 'Each lane ran its own job', path: ['this', 'lanes', '*'], lane: 'lane', job: 'job', prefix: 'job-', lanes: ['north', 'south'] };
const lookups = [
  ['lane-jobs', [laneJobs],
    [[{ lanes: [{ lane: 'north', job: 'job-north' }, { lane: 'south', job: 'job-south' }] }, []],
     [{ lanes: [{ lane: 'north', job: 'job-north' }] }, ['Each lane ran its own job']],
     [{ lanes: [{ lane: 'north', job: 'job-south' }, { lane: 'south', job: 'job-south' }] }, ['Each lane ran its own job']],
     [{ lanes: [{ lane: 'north', job: 'job-north' }, { lane: 'south', job: 'job-south' }, { lane: 'west', job: 'job-west' }] }, ['Each lane ran its own job']]]],
];

for (const [name, checks, answers] of lookups) {
  test(`${name}: the lookup steps judge each answer as the older check step did`, () => holdsAsBefore(name, checks, {}, answers, host));
}

test('lane-jobs: one taker finishing two lanes is refused', async () => {
  const run = await judged([{ ...laneJobs, lanes: ['north', 'east'] }], {}, { lanes: [{ lane: 'north', job: 'job-north' }, { lane: 'east', job: 'job-east' }] }, host);
  assert.equal(run.status, 'failed');
  assert.match(run.error_message, /Each lane ran its own job \("the same taker finished more than one lane"\)/);
});

// Kinds the older check step never ran (it refused them by name): each answer is held to the kind's meaning.
const meant = [
  ['differs-from', [{ kind: 'differs-from', says: 'Not the main one', path: ['this', 'domains', '*', 'domain'], of: ['input', 'main'] }], { main: 'main.example.com' },
    [[{ domains: [{ domain: 'x.example.com' }] }, null], [{ domains: [{ domain: 'x.example.com' }, { domain: 'main.example.com' }] }, '"main.example.com"']]],
  ['field-in', [{ kind: 'field-in', says: 'A current kind', path: ['this', 'findings', '*'], field: 'kind', values: ['measured', 'read'] }], {},
    [[{ findings: [{ kind: 'read' }, { kind: 'measured' }] }, null], [{ findings: [{ kind: 'read' }, { kind: 'guessed' }] }, '"guessed"']]],
  ['fields-present', [{ kind: 'fields-present', says: 'Each has a name and a source', path: ['this', 'rows', '*'], fields: ['name', 'source'] }], {},
    [[{ rows: [{ name: 'a', source: 's' }] }, null], [{ rows: [{ name: 'a', source: '' }, { name: 'b', source: 's' }] }, '{"name":"a","source":""}'], [{ rows: [{ name: 'b' }] }, '{"name":"b"}']]],
];

for (const [name, checks, input, answers] of meant) {
  test(`${name}: each answer is held to the kind's meaning`, async () => {
    for (const [answer, breaks] of answers) {
      const run = await judged(checks, input, answer);
      const label = `${name} ${JSON.stringify(answer)}: ${run.error_message ?? ''}`;
      if (breaks === null) assert.equal(run.status, 'completed', label);
      else assert.ok(run.status === 'failed' && run.error_message.includes(`${checks[0].says} (${breaks})`), label);
    }
  });
}

test('a refusal names the rule and the values that break it', async () => {
  const run = await judged(cases[0][1], cases[0][2], { picked: ['a', 'z', 'q'] });
  assert.equal(run.status, 'failed');
  assert.match(run.error_message, /Only allowed \("z"; "q"\)/);
});
