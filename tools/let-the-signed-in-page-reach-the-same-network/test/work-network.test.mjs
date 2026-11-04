import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkNetwork, isWorkNetworkPath } from '../src/work-network.mjs';

test('the signed-in network page reads and writes through the person network owner', async () => {
  const calls = [];
  const person = { fetch: async request => { calls.push({ method: request.method, url: request.url, origin: request.headers.get('x-trillion-origin'), body: request.method === 'GET' ? null : await request.json() }); return Response.json({ ok: true }); } };
  assert.equal(isWorkNetworkPath('/work/api/network/people'), true);
  const origin = 'https://app.gettrillion.ai';
  const people = new Request(`${origin}/work/api/network/people?limit=10`);
  assert.equal((await handleWorkNetwork(people, { person, origin, url: new URL(people.url) })).status, 200);
  const profile = new Request(`${origin}/work/api/network/profile`, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ findable: true, name: 'Ada' }) });
  assert.equal((await handleWorkNetwork(profile, { person, origin, url: new URL(profile.url) })).status, 200);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [['GET', 'https://person/network/people?limit=10'], ['PUT', 'https://person/network/profile']]);
  assert.deepEqual(calls[1].body, { findable: true, name: 'Ada' });
  assert.equal(calls[1].origin, origin);
});

test('a different origin cannot change a network profile', async () => {
  let called = false;
  const person = { fetch: () => { called = true; return Response.json({}); } };
  const origin = 'https://app.gettrillion.ai';
  const request = new Request(`${origin}/work/api/network/profile`, { method: 'PUT', headers: { origin: 'https://other.example' }, body: '{}' });
  const response = await handleWorkNetwork(request, { person, origin, url: new URL(request.url) });
  assert.equal(response.status, 403);
  assert.equal(called, false);
});
