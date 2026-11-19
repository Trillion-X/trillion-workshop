// A saved setup list is one row of choices, and one workflow runs the workflow each choice names. Changing a choice
// changes which workflow runs, with nothing else changed. Made-up values only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflowEngine } from '../read-data/run-a-workflow.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';
import { RUN_ACTOR } from '../read-data/workflows.mjs';

const { definitions } = JSON.parse(await readFile(new URL('../../workflows/definitions/set-up-from-a-saved-list.json', import.meta.url), 'utf8'));
// Example key shapes a caller keeps as its own rows; the workflow names none of them.
const exampleShapes = [
  { says: 'payment key', pattern: 'sk_(live|test)_[A-Za-z0-9]{20,}' },
  { says: 'code host token', pattern: 'gh[pousr]_[A-Za-z0-9]{30,}' },
  { says: 'cloud key id', pattern: 'AKIA[0-9A-Z]{16}' },
  { says: 'signed token', pattern: 'eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}' },
];
const asking = id => ({ id, name: id, kind: 'workflow', is_active: true, version: 1, edges: [],
  steps: [{ id: 'ask-the-person', kind: 'ask', config: { name: RUN_ACTOR, input: { $kind: 'binding', select: { from: 'input' } }, context: { step_id: 'ask-the-person' } } }] });
const chosen = [asking('workflow:made-up-rent-a-computer'), asking('workflow:made-up-use-a-computer-i-have'), asking('workflow:made-up-make-the-databases')];
// The host answers a lookup of a workflow by id: the workflows the account has are the made-up ones above.
const host = { read: async from => {
  const { catalog, id } = JSON.parse(from);
  if (catalog !== 'workflow' || !chosen.some(definition => definition.id === id)) throw new Error(`no ${catalog} ${id}`);
  return new TextEncoder().encode(JSON.stringify({ id }));
} };
const run = (choices, shapes = exampleShapes) => makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition(
  { definitions: [...definitions, ...chosen], workflow_id: 'workflow:set-up-from-a-saved-list', input: { choices, ...(shapes === null ? {} : { secret_shapes: shapes }) }, answers: {} }, host);
const waitingOn = run => JSON.stringify(run.execution_context?.steps?.['each-choice']?.output ?? null);

const saved = [
  { job: 'get a computer', definition_id: 'workflow:made-up-rent-a-computer', input: { provider: 'made-up-cloud' } },
  { job: 'keep data', definition_id: 'workflow:made-up-make-the-databases', input: { extension: 'vector' } },
];

test('the saved list runs the workflow its first choice names and pauses at that workflow’s question', async () => {
  const result = await run(saved);
  assert.equal(result.status, 'paused');
  assert.match(waitingOn(result), /made-up-rent-a-computer/);
});

test('changing one choice runs the other workflow, with nothing else changed', async () => {
  const result = await run([{ ...saved[0], definition_id: 'workflow:made-up-use-a-computer-i-have' }, saved[1]]);
  assert.equal(result.status, 'paused');
  assert.match(waitingOn(result), /made-up-use-a-computer-i-have/);
  assert.doesNotMatch(waitingOn(result), /made-up-rent-a-computer/);
});

test('an empty list sets up nothing and finishes', async () => {
  assert.equal((await run([])).status, 'completed');
});

test('a choice naming a workflow that does not exist is refused in the words of its job', async () => {
  const result = await run([saved[0], { job: 'keep the notes somewhere safe', definition_id: 'workflow:made-up-missing', input: {} }]);
  assert.equal(result.status, 'failed');
  assert.match(result.error_message, /keep the notes somewhere safe/);
  assert.match(result.error_message, /does not exist/);
  assert.doesNotMatch(result.error_message, /not hydrated/);
});

// Values shaped like keys, made up from pieces so no real key is written here.
const keyed = {
  'payment key': ['sk_', 'live_', 'a1B2c3D4e5F6g7H8i9J0k1'].join(''),
  'code host token': ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7'].join(''),
  'cloud key id': ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
  'signed token': ['eyJ', 'abcdefghijklmnopqrstu', '.', 'abcdefghijklmnopqrstu', '.', 'abcdefghijklmnopqrstu'].join(''),
};
const withValue = value => [{ ...saved[0], input: { provider: 'made-up-cloud', token: value } }, saved[1]];

for (const [name, value] of Object.entries(keyed)) {
  test(`shapes handed in catch a ${name}-shaped value before anything runs`, async () => {
    const result = await run(withValue(value));
    assert.equal(result.status, 'failed');
    assert.match(result.error_message, /vault names only/);
    assert.ok(result.error_message.includes(name), 'the refusal names the shape');
    assert.ok(!result.error_message.includes(value), 'the refusal never repeats the value');
    assert.doesNotMatch(waitingOn(result), /made-up-rent-a-computer/);
  });
}

for (const [label, shapes] of [['missing', null], ['empty', []]]) {
  test(`${label} secret shapes are refused, never treated as nothing to check`, async () => {
    const result = await run(saved, shapes);
    assert.equal(result.status, 'failed');
    assert.match(result.error_message, /No secret shapes were handed in; nothing is checked, so nothing runs/);
    assert.doesNotMatch(waitingOn(result), /made-up-rent-a-computer/);
  });
}

test('a clean list with shapes handed in runs; a vault name is not a secret value', async () => {
  const result = await run([{ ...saved[0], input: { provider: 'made-up-cloud', key_name: 'made-up-cloud-api-key' } }]);
  assert.equal(result.status, 'paused');
  assert.match(waitingOn(result), /made-up-rent-a-computer/);
});

test('a shape nobody named before works with no change to the definition', async () => {
  const acme = [{ says: 'acme key', pattern: 'acme-[a-z0-9]{12,}' }];
  const result = await run(withValue('acme-q1w2e3r4t5y6u7'), acme);
  assert.equal(result.status, 'failed');
  assert.match(result.error_message, /acme key/);
  assert.equal((await run(withValue('acme-q1w2e3r4t5y6u7'), exampleShapes)).status, 'paused');
});
