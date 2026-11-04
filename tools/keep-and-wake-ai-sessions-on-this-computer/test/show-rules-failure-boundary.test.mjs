import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkFailure } from '../src/failure.mjs';
import { handleShowRulesRequest } from '../src/show-rules-store.mjs';

const request = (method = 'GET', path = '/show-rules') => new Request(`https://person${path}`, { method });

test('show-rules reads propagate backend failures to the shared failure owner', async () => {
  const busy = new WorkFailure('service-busy', 'overloaded store');
  await assert.rejects(handleShowRulesRequest({ read: async () => { throw busy; } }, request()), error => error === busy);

  const backend = new Error('account record read failed');
  await assert.rejects(handleShowRulesRequest({ read: async () => { throw backend; } }, request()), error => error === backend);
});

test('show-rules writes propagate known shared operational and platform failures', async () => {
  const exhausted = new WorkFailure('resource-exhausted', 'record store exhausted');
  await assert.rejects(handleShowRulesRequest({ set: async () => { throw exhausted; } }, request('POST', '/show-rules/set')),
    error => error === exhausted);

  const overloaded = new Error('Durable Object is overloaded');
  await assert.rejects(handleShowRulesRequest({ set: async () => { throw overloaded; } }, request('POST', '/show-rules/set')),
    error => error === overloaded);
});

test('show-rules edit validation remains a 400 response', async () => {
  const response = await handleShowRulesRequest({ set: async () => { throw new Error('An edit rule needs an id and allow or deny effect.'); } },
    request('POST', '/show-rules/set'));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'An edit rule needs an id and allow or deny effect.' });
});

test('explicit shared request refusals remain client errors', async () => {
  const response = await handleShowRulesRequest({ set: async () => { throw new WorkFailure('request-refused', 'Edit not permitted.'); } },
    request('POST', '/show-rules/set'));
  assert.equal(response.status, 400);
});

test('an actor the edit rules do not allow is refused as 403, not as a malformed request', async () => {
  const response = await handleShowRulesRequest({ set: async () => { throw Object.assign(new Error('The current show-rule edit rules do not let this account actor make that change.'), { status: 403 }); } },
    request('POST', '/show-rules/set'));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'The current show-rule edit rules do not let this account actor make that change.' });
});
