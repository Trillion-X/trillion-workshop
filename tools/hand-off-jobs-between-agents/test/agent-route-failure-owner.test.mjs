import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentsRequest } from '../../shared-code/src/agents.mjs';
import { WorkFailure, failureOf } from '../../shared-code/src/failure.mjs';
const request = body => new Request('https://fixture.test/handoffs/finish', { method: 'POST', body });
test('agent actions preserve unexpected storage failure and temporary service failure for the shared host owner', async () => {
  for (const error of [new TypeError('Synthetic backend method failed'), new WorkFailure('service-busy', 'Synthetic current policy fence')]) {
    await assert.rejects(handleAgentsRequest({ finish: () => { throw error; } }, request('{}')), held => held === error);
  }
  assert.equal(failureOf(new WorkFailure('service-busy', 'Synthetic fence')).tries_again_later, true);
});
test('malformed action JSON remains a domain refusal without invoking work', async () => {
  let invoked = false;
  const response = await handleAgentsRequest({ finish: () => { invoked = true; } }, request('{'));
  assert.equal(response.status, 400);
  assert.equal(invoked, false);
  assert.match((await response.json()).error, /valid JSON/);
});
