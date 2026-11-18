// Connecting a service by its key: the person is asked to copy the key, then the vault tool is asked to keep it under the
// chosen name, sent only to the hosts the input names. The value is never in any step's input. Made-up values only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflowEngine } from '../read-data/run-a-workflow.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const { definitions } = JSON.parse(await readFile(new URL('../../workflows/definitions/connect-a-service-by-key.json', import.meta.url), 'utf8'));
const input = { service: 'made-up-mail', name: 'made-up-mail-key', hosts: 'api.example.com,mcp.example.com', where_to_find_the_key: 'Settings, then Keys' };
const run = answers => makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition(
  { definitions, workflow_id: 'workflow:connect-a-service-by-key', input, answers });

test('the run first asks the person where to copy the key from, and pauses there', async () => {
  const result = await run({});
  assert.equal(result.status, 'paused');
  const [asked] = result.waiting;
  assert.equal(asked.asks, 'person');
  assert.deepEqual(asked.input, { do: 'Settings, then Keys', service: 'made-up-mail', then: 'Copy the key, then say it is copied. Never paste it into a chat.' });
});

test('once the person says it is copied, the vault tool is asked with the name and the hosts, and nothing else', async () => {
  const result = await run({ 'get-the-key': { copied: true } });
  const [asked] = result.waiting;
  assert.equal(asked.asks, 'tool:keep-a-secret-by-name');
  assert.deepEqual(asked.input, { arguments: ['made-up-mail-key', '--hosts', 'api.example.com,mcp.example.com'] });
});
