// Making a signing key in the vault: the run asks the door's secrets:generate with the name, and is done once the vault
// answers. Made-up values only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflowEngine } from '../read-data/run-a-workflow.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';
import calls from '../../tell-ais-how-to-act/door-calls.json' with { type: 'json' };

const { definitions } = JSON.parse(await readFile(new URL('../../workflows/definitions/make-a-signing-key-in-the-vault.json', import.meta.url), 'utf8'));
const run = answers => makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition(
  { definitions, workflow_id: 'workflow:make-a-signing-key-in-the-vault', input: { name: 'made-up-signing-key' }, answers });

test('the run asks the vault to make the key under the name, and is done when it answers', async () => {
  const asked = await run({});
  assert.equal(asked.status, 'paused');
  assert.deepEqual(asked.waiting.map(item => [item.asks, item.input]), [['secrets:generate', { name: 'made-up-signing-key' }]]);
  assert.ok(calls.calls.includes('secrets:generate'), 'the door answers it');
  const done = await run({ 'make-the-key': { name: 'made-up-signing-key', scheme: 'ed25519', public_key: 'ab'.repeat(32) } });
  assert.equal(done.status, 'completed');
});
