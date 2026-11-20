// Tests for withCorrections (read-data/check-bindings.mjs): one correction round for every checked step, run on the
// Workshop runner. The steps, ids and answers are made up; what a test checks is where a run goes and what it reads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSteps, withCorrections } from '../read-data/check-bindings.mjs';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';

const rule = { kind: 'distinct-at-least', path: ['this', 'items', '*', 'id'], count: 3, says: 'At least three separate items are listed' };
const submit = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } };
const ask = (id, extra = {}) => ({ id, kind: 'ask', config: { name: 'anyone', input: { do: `Do ${id}.`, submit, checks: [rule.says], ...extra }, context: { step_id: id, title: id, do: `Do ${id}.`, submit, checks: [rule] } } });

// list (checked) -> use, where use reads list's items.
function sample() {
  const judged = checkSteps('list', [rule]);
  const use = { id: 'use', kind: 'ask', config: { name: 'anyone', input: { do: 'Use the list.', items: { $kind: 'binding', select: { from: 'steps', key: 'list', path: 'output.items' } }, submit: { type: 'object' } }, context: { step_id: 'use' } } };
  return { steps: [ask('list'), ...judged.steps, use], edges: [...judged.edges, judged.onwards('use')] };
}

const items = (...ids) => ({ items: ids.map(id => ({ id })) });
const id = 'workflow:sample-correction';
const run = (definition, answers) => runWorkflow({ definitions: [{ id, name: id, kind: 'workflow', is_active: true, version: 1, ...definition }], workflow_id: id, input: {}, answers, partition: 'person' });

test('a checked step gets one round: the correction ask, its own checks, and the answer later steps read', () => {
  const { definition, subjects } = withCorrections(sample());
  assert.deepEqual(subjects, ['list']);
  assert.deepEqual(definition.steps.map(step => step.id), ['list', 'list#checks', 'list#wrong', 'list#refused', 'list#again', 'list#again#checks', 'list#again#wrong', 'list#again#refused', 'list#answer', 'use']);
  assert.equal(definition.steps.find(step => step.id === 'list#again').config.name, 'anyone');
  assert.equal(definition.steps.find(step => step.id === 'list#again').config.input.refused_answer, undefined, 'the refused answer is not copied');
  assert.deepEqual(definition.steps.find(step => step.id === 'use').config.input.items.select, { from: 'steps', key: 'list#answer', path: 'output.items' });
  assert.ok(definition.edges.some(edge => edge.from === 'list#refused' && edge.to === 'list#again' && edge.kind === 'on_failure'));
  assert.ok(definition.edges.some(edge => edge.from === 'list#answer' && edge.to === 'use'));
  assert.deepEqual(withCorrections(definition).subjects, [], 'a second run changes nothing');
});

test('a refused answer waits as a correction; a corrected one reaches the next step', async () => {
  const { definition } = withCorrections(sample());
  const first = await run(definition, { list: items('a', 'a', 'a') });
  assert.equal(first.status, 'paused');
  assert.deepEqual(first.waiting.map(item => item.step_id), ['list#again']);
  assert.match(JSON.stringify(first.waiting[0].input.refused), /At least three separate items are listed/);
  const second = await run(definition, { list: items('a', 'a', 'a'), 'list#again': items('a', 'b', 'c') });
  assert.deepEqual(second.waiting.map(item => item.step_id), ['use']);
  assert.deepEqual(second.waiting[0].input.items.map(item => item.id), ['a', 'b', 'c']);
});

test('a second refusal fails the run in the rule\'s words; a good first answer goes straight on', async () => {
  const { definition } = withCorrections(sample());
  const twice = await run(definition, { list: items('a', 'a', 'a'), 'list#again': items('b', 'b', 'b') });
  assert.equal(twice.status, 'failed');
  assert.match(String(twice.error_message), /At least three separate items are listed/);
  const good = await run(definition, { list: items('a', 'b', 'c') });
  assert.deepEqual(good.waiting.map(item => item.step_id), ['use']);
  assert.deepEqual(good.waiting[0].input.items.map(item => item.id), ['a', 'b', 'c']);
});
