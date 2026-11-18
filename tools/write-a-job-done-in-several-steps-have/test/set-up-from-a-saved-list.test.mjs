// A saved setup list is one row of choices, and one workflow runs the workflow each choice names. Changing a choice
// changes which workflow runs, with nothing else changed. Made-up values only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflowEngine } from '../read-data/run-a-workflow.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const { definitions } = JSON.parse(await readFile(new URL('../../workflows/definitions/set-up-from-a-saved-list.json', import.meta.url), 'utf8'));
const asking = id => ({ id, name: id, kind: 'workflow', is_active: true, version: 1, edges: [],
  steps: [{ id: 'ask-the-person', kind: 'ask', config: { name: 'ai', input: { $kind: 'binding', select: { from: 'input' } }, context: { step_id: 'ask-the-person' } } }] });
const chosen = [asking('workflow:made-up-rent-a-computer'), asking('workflow:made-up-use-a-computer-i-have'), asking('workflow:made-up-make-the-databases')];
const run = choices => makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition(
  { definitions: [...definitions, ...chosen], workflow_id: 'workflow:set-up-from-a-saved-list', input: { choices }, answers: {} }, {});
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
