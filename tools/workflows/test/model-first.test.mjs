// Tests for withModelFirst (read-data/check-bindings.mjs): a word-only ask is put to the person's own computer's model
// first, run on the Workshop runner. The steps, ids and answers are made up; what a test checks is where a run goes and
// what it reads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSteps, withCorrections, withModelFirst, wordOnly } from '../read-data/check-bindings.mjs';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';

const rule = { kind: 'distinct-at-least', path: ['this', 'items', '*', 'id'], count: 3, says: 'At least three separate items are listed' };
const submit = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } };
const notes = { $kind: 'binding', select: { from: 'steps', key: 'read', path: 'output.notes' } };

// read -> list (word-only: handed notes, checked) -> use, where use reads list's items.
function sample({ checked = true, input = { notes }, marked = true } = {}) {
  const read = { id: 'read', kind: 'ask', config: { name: 'anyone', input: { do: 'Read the notes.', submit: { type: 'object' } }, context: { step_id: 'read' } } };
  const list = { id: 'list', kind: 'ask', config: { name: 'anyone', input: { do: 'List the items the notes name.', submit, checks: checked ? [rule.says] : [], ...input },
    context: { step_id: 'list', title: 'List the items', do: 'List the items the notes name.', submit, checks: checked ? [rule] : [], word_only: marked } } };
  // use is asked of the person, so it stays an ask of theirs.
  const use = { id: 'use', kind: 'ask', config: { name: 'person', input: { do: 'Use the list.', items: { $kind: 'binding', select: { from: 'steps', key: 'list', path: 'output.items' } }, submit: { type: 'object' } }, context: { step_id: 'use' } } };
  if (!checked) return { steps: [read, list, use], edges: [{ from: 'read', to: 'list', kind: 'always' }, { from: 'list', to: 'use', kind: 'always' }] };
  const judged = checkSteps('list', [rule]);
  return { steps: [read, list, ...judged.steps, use], edges: [{ from: 'read', to: 'list', kind: 'always' }, ...judged.edges, judged.onwards('use')] };
}

const compiled = options => withModelFirst(withCorrections(sample(options)).definition);
const items = (...ids) => ({ items: ids.map(id => ({ id })) });
const said = content => ({ choices: [{ index: 0, message: { role: 'assistant', content } }] });
const id = 'workflow:sample-model-first';
const run = (definition, answers) => runWorkflow({ definitions: [{ id, name: id, kind: 'workflow', is_active: true, version: 1, ...definition }], workflow_id: id, input: {}, answers, partition: 'person' });
const read = { read: { notes: 'apples, pears and plums' } };

test('a word-only ask is one handed values beyond its words that names no tool and reads nothing it is not handed', () => {
  const ask = input => ({ id: 's', kind: 'ask', config: { name: 'anyone', input: { do: 'Sort them.', submit, ...input } } });
  assert.equal(wordOnly(ask({ notes })), true);
  assert.equal(wordOnly(ask({})), false, 'handed nothing: it reads what it needs itself');
  assert.equal(wordOnly(ask({ notes, do: 'Run tool:send-a-post with them.' })), false, 'names a tool');
  assert.equal(wordOnly(ask({ notes, do: 'Read steps.read.output and sort it.' })), false, 'reads another step');
  assert.equal(wordOnly(ask({ notes, do: 'Sort input.notes by input.owner.' })), false, 'reads a run value it is not handed');
  assert.equal(wordOnly(ask({ notes, do: 'Sort input.notes.' })), true);
  assert.equal(wordOnly({ ...ask({ notes }), config: { ...ask({ notes }).config, name: 'tool:draft-a-post' } }), false, 'asked of a tool');
});

test('the model is asked first with the ask\'s words, shape and handed values; a second compile changes nothing', async () => {
  const { definition, subjects } = compiled();
  assert.deepEqual(subjects, ['list']);
  const model = definition.steps.find(step => step.id === 'list#model');
  assert.equal(model.config.name, 'tool:ask-a-model');
  assert.equal(model.config.input.job, 'do-a-task-step');
  assert.deepEqual(withModelFirst(withCorrections(sample({ marked: false })).definition).subjects, [], 'an ask not marked word_only is left as it is');
  assert.deepEqual(withModelFirst(definition).subjects, [], 'a second run changes nothing');
  const first = await run(definition, read);
  assert.deepEqual(first.waiting.map(item => item.step_id), ['list#model'], 'the model is asked, not a person');
  const [system, user] = first.waiting[0].input.messages;
  assert.match(system.content, /"required":\["items"\]/);
  assert.equal(user.content, 'List the items the notes name.\n\nInput:\n{"notes":"apples, pears and plums"}');
});

test('a model answer that holds goes straight on, and the ask is never put to anyone', async () => {
  const done = await run(compiled().definition, { ...read, 'list#model': said(JSON.stringify(items('apples', 'pears', 'plums'))) });
  assert.deepEqual(done.waiting.map(item => item.step_id), ['use']);
  assert.deepEqual(done.waiting[0].input.items.map(item => item.id), ['apples', 'pears', 'plums']);
});

test('a model answer that is refused, not JSON or short of a field makes the ask the task it is today', async () => {
  for (const content of [JSON.stringify(items('apples', 'apples', 'apples')), 'Here are the items: apples, pears', JSON.stringify({ list: ['apples'] }), null]) {
    const fallen = await run(compiled().definition, { ...read, 'list#model': content === null ? { error: 'No model on this computer answered.' } : said(content) });
    assert.deepEqual(fallen.waiting.map(item => item.step_id), ['list'], String(content));
  }
  const corrected = await run(compiled().definition, { ...read, 'list#model': said('not json'), list: items('a', 'a', 'a'), 'list#again': items('a', 'b', 'c') });
  assert.deepEqual(corrected.waiting.map(item => item.step_id), ['use'], 'the task keeps its own correction round');
  assert.deepEqual(corrected.waiting[0].input.items.map(item => item.id), ['a', 'b', 'c']);
});

test('an unchecked word-only ask gets an answer step of its own, checked for the fields its shape requires', async () => {
  const { definition, subjects } = compiled({ checked: false });
  assert.deepEqual(subjects, ['list']);
  assert.deepEqual(definition.steps.find(step => step.id === 'use').config.input.items.select, { from: 'steps', key: 'list#answer', path: 'output.items' });
  const good = await run(definition, { ...read, 'list#model': said(JSON.stringify(items('x'))) });
  assert.deepEqual(good.waiting.map(item => item.step_id), ['use']);
  assert.deepEqual(good.waiting[0].input.items.map(item => item.id), ['x']);
  const short = await run(definition, { ...read, 'list#model': said('{}') });
  assert.deepEqual(short.waiting.map(item => item.step_id), ['list']);
  const asked = await run(definition, { ...read, 'list#model': said('{}'), list: items('y') });
  assert.deepEqual(asked.waiting[0].input.items.map(item => item.id), ['y'], 'the person\'s answer is the one read');
});
