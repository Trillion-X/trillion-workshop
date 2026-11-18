// Getting a computer from its description: the price is read, the person approves paying it each month, and only then is
// start-a-computer asked to rent and set up the machine. Made-up values only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflowEngine } from '../read-data/run-a-workflow.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const { definitions } = JSON.parse(await readFile(new URL('../../workflows/definitions/get-a-computer-from-its-description.json', import.meta.url), 'utf8'));
const input = { request_file: '/made-up/computers/example/start-request.json' };
const price = { provider: 'made-up-cloud', terms_url: 'https://example.com/terms', placement: { size: 'small' }, price: { monthly: '4.50', currency: 'EUR' } };
const run = answers => makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition(
  { definitions, workflow_id: 'workflow:get-a-computer-from-its-description', input, answers });

test('the run first asks the price tool with the request the person keeps, and pauses there', async () => {
  const result = await run({});
  assert.equal(result.status, 'paused');
  const [asked] = result.waiting;
  assert.equal(asked.asks, 'tool:read-a-computer-price');
  assert.deepEqual(asked.input, { request_file: input.request_file });
});

test('the person is shown the price and its terms before anything is rented', async () => {
  const [asked] = (await run({ 'read-the-price': price })).waiting;
  assert.equal(asked.asks, 'person');
  assert.deepEqual(asked.input, { price: price.price, terms: price.terms_url, then: 'Say yes to rent this machine and pay this price each month, or no to stop.' });
});

test('a yes asks start-a-computer with the same request', async () => {
  const [asked] = (await run({ 'read-the-price': price, 'approve-the-price': { yes: true } })).waiting;
  assert.equal(asked.asks, 'tool:start-a-computer');
  assert.deepEqual(asked.input, { request_file: input.request_file });
});

test('a no ends the run with nothing rented', async () => {
  const result = await run({ 'read-the-price': price, 'approve-the-price': { yes: false } });
  assert.notEqual(result.status, 'paused');
  assert.ok(!(result.waiting ?? []).some(asked => asked.asks === 'tool:start-a-computer'));
});
