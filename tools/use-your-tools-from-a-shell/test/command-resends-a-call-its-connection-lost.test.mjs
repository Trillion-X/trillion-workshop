// tools/use-your-tools-from-a-shell/test/command-resends-a-call-its-connection-lost.test.mjs
//
// A call sent once (MCP initialize, `whoami`) is sent again one time, after the first retry gap, when its connection ended before any answer, as
// a front door's reload does to a kept-alive connection a call is already on. A door that answers 503 or never answers is still
// asked only once, so `whoami` against a stopped engine does not wait through every retry gap.
import assert from 'node:assert/strict';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { engineClient, speakFor } from '../do-work/command.mjs';

speakFor({ cli: 'example', site_name: 'Example' });

const credential = { kind: 'key', bearer: `nm_${'ab'.repeat(16)}`, where: 'test' };
const door = { name: 'test door', mcp: 'http://127.0.0.1:8788/mcp', local: false };
const lostConnection = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
const answer = body => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { _meta: { account: { account_id: 'acct_1' } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
const waits = [];
const noWait = async ms => { waits.push(ms); };

test('whoami is sent again, after one retry gap, when its connection ended before any answer', async () => {
  let sent = 0; waits.length = 0;
  const fetchImpl = async (_url, init) => { sent += 1; if (sent === 1) throw lostConnection(); return answer(init.body); };
  const who = await engineClient({ door, credential, fetchImpl, wait: noWait }).whoami();
  assert.equal(who.account, 'acct_1');
  assert.equal(sent, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= settings.retry.first_seconds * 1000, 'one first gap, not the climbing gaps');
});

test('a connection lost twice in a row is said once, after one resend', async () => {
  let sent = 0;
  const fetchImpl = async () => { sent += 1; throw lostConnection(); };
  await assert.rejects(engineClient({ door, credential, fetchImpl, wait: noWait }).whoami(), error => error.status === 4 && /could not be reached/.test(error.message));
  assert.equal(sent, 2);
});

test('a door that answers 503 is still asked once', async () => {
  let sent = 0;
  const fetchImpl = async () => { sent += 1; return new Response('', { status: 503 }); };
  await assert.rejects(engineClient({ door, credential, fetchImpl, wait: noWait }).whoami());
  assert.equal(sent, 1);
});

test('a door that never answers is asked once', async () => {
  let sent = 0;
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => { sent += 1; init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
  await assert.rejects(engineClient({ door, credential, fetchImpl, wait: noWait, timeoutSeconds: 0.05 }).whoami());
  assert.equal(sent, 1);
  assert.ok(settings.retry.count > 0);
});
