import test from 'node:test';
import assert from 'node:assert/strict';
import { engineClient } from '../do-work/command.mjs';

const door = { mcp: 'https://door.example.test/mcp', name: 'Example', local: false, public: true };
const answered = id => new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: { ok: true } } }), { status: 200, headers: { 'content-type': 'application/json' } });

test('a sign-in that ended while the command ran is renewed once on the door\'s 401 and the call is sent again', async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(init.headers.authorization);
    return init.headers.authorization === 'Bearer ended' ? new Response('', { status: 401 }) : answered(JSON.parse(init.body).id);
  };
  let renewals = 0;
  const client = engineClient({ door, credential: { kind: 'sign-in', bearer: 'ended' }, fetchImpl, renew: async () => { renewals += 1; return { kind: 'sign-in', bearer: 'renewed' }; } });
  assert.deepEqual(await client.op(null, 'wake:list', {}), { ok: true });
  assert.deepEqual(sent, ['Bearer ended', 'Bearer renewed']);
  assert.equal(renewals, 1);
});

test('a renewal that brings nothing new, or a 401 after renewing, is the refusal it was', async () => {
  const fetchImpl = async () => new Response('', { status: 401 });
  const same = engineClient({ door, credential: { kind: 'sign-in', bearer: 'ended' }, fetchImpl, renew: async () => ({ kind: 'sign-in', bearer: 'ended' }) });
  await assert.rejects(same.op(null, 'wake:list', {}), error => error.status === 3);
  let renewals = 0;
  const twice = engineClient({ door, credential: { kind: 'sign-in', bearer: 'ended' }, fetchImpl, renew: async () => { renewals += 1; return { kind: 'sign-in', bearer: `new-${renewals}` }; } });
  await assert.rejects(twice.op(null, 'wake:list', {}), error => error.status === 3);
  assert.equal(renewals, 1, 'renewed once, never in a loop');
});
