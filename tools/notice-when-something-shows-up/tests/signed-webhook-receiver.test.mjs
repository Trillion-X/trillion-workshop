// The signed webhook receiver with made-up secrets and calls: a good standard-webhooks call told as one fact, a bad
// signature refused and told to nobody, a replay told once, a wrong path, an oversized body and an unknown event type
// answered by their own codes, and a 503 when the engine does not take the fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReceiver, receiverConfigOf, startReceiver } from '../do-work/signed-webhook-receiver.mjs';

const NOW = 1795050000000;
const SECRET = `whsec_${Buffer.from('made-up-receiver-key').toString('base64')}`;
const SHAPE = {
  place: { path: 'type' },
  change: { path: 'type', map: { 'email.delivered': 'changed', 'email.opened': 'changed', 'email.clicked': 'changed', 'email.bounced': 'changed', 'email.complained': 'changed' } },
  key: ['data.email_id'],
  at: ['data.created_at', 'created_at'],
  at_unit: 'iso',
};
const CONFIG = receiverConfigOf({
  listen_host: '127.0.0.1', listen_port: 0, path: '/webhooks/resend', secret_credential: 'resend-webhook-signing-secret',
  verify: 'standard-webhooks', shape: SHAPE, where: 'resend', kind: 'resend-email-event', door_file: '/unused',
});
const event = (type = 'email.delivered', email = 'em_1', created = '2026-11-21T19:00:00.000Z') =>
  JSON.stringify({ type, created_at: created, data: { email_id: email, created_at: created } });
const signed = (body, { id = 'msg_1', ts = Math.floor(NOW / 1000), secret = SECRET } = {}) => {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`,
  };
};

/** A receiver listening on a free port, with the engine stood in by `arrive` (a list it writes its facts to). */
async function serve({ config = CONFIG, arrive = async () => {} } = {}) {
  const facts = [];
  const server = createReceiver({ config, secret: SECRET, arrive: async (fact) => { facts.push(fact); await arrive(fact); }, now: () => NOW });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, facts, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function post(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a good signed call is told as one fact with its where, place, change, key, time and after', async () => {
  const { facts, port, close } = await serve();
  try {
    const body = event();
    const answer = await post(port, '/webhooks/resend', signed(body), body);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { recorded: true, changes: 1, duplicates: 0 });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, 'resend-email-event');
    assert.equal(facts[0].event_id, 'resend:email.delivered:em_1:changed:2026-11-21T19:00:00.000Z');
    assert.deepEqual(Object.keys(facts[0].payload).sort(), ['after', 'at', 'change', 'key', 'place', 'where']);
    assert.equal(facts[0].payload.key, 'em_1');
    assert.equal(facts[0].payload.place, 'email.delivered');
    assert.equal(facts[0].payload.where, 'resend');
  } finally {
    await close();
  }
});

test('a bad signature is answered 401 and told to nobody', async () => {
  const { facts, port, close } = await serve();
  try {
    const body = event();
    const answer = await post(port, '/webhooks/resend', signed(body, { secret: `whsec_${Buffer.from('someone-else').toString('base64')}` }), body);
    assert.equal(answer.status, 401);
    assert.equal(answer.json.reason, 'signature-mismatch');
    assert.equal(facts.length, 0);
  } finally {
    await close();
  }
});

test('a replayed event key is told once; the repeat is answered 200 as a duplicate', async () => {
  const { facts, port, close } = await serve();
  try {
    const body = event();
    const first = await post(port, '/webhooks/resend', signed(body), body);
    const second = await post(port, '/webhooks/resend', signed(body, { id: 'msg_1' }), body);
    assert.equal(first.json.duplicates, 0);
    assert.deepEqual(second.json, { recorded: true, changes: 1, duplicates: 1 });
    assert.equal(facts.length, 1);
  } finally {
    await close();
  }
});

test('a second open of the same email, at a later time, is a different fact', async () => {
  const { facts, port, close } = await serve();
  try {
    const first = event('email.opened', 'em_1', '2026-11-21T19:01:00.000Z');
    const second = event('email.opened', 'em_1', '2026-11-21T19:02:00.000Z');
    await post(port, '/webhooks/resend', signed(first), first);
    await post(port, '/webhooks/resend', signed(second, { id: 'msg_2' }), second);
    assert.equal(facts.length, 2);
    assert.notEqual(facts[0].event_id, facts[1].event_id);
  } finally {
    await close();
  }
});

test('a call on another path is answered 404 and read no further', async () => {
  const { facts, port, close } = await serve();
  try {
    const body = event();
    const answer = await post(port, '/somewhere-else', signed(body), body);
    assert.equal(answer.status, 404);
    assert.equal(facts.length, 0);
  } finally {
    await close();
  }
});

test('a body over the configured ceiling is answered 413 and nothing is told', async () => {
  const small = receiverConfigOf({ ...CONFIG, body_byte_ceiling: 64 });
  const { facts, port, close } = await serve({ config: small });
  try {
    const body = event();
    assert.ok(Buffer.byteLength(body) > 64);
    const answer = await post(port, '/webhooks/resend', signed(body), body);
    assert.equal(answer.status, 413);
    assert.equal(facts.length, 0);
  } finally {
    await close();
  }
});

test('an event type the shape does not read is answered 200 and told as one refused fact', async () => {
  const { facts, port, close } = await serve();
  try {
    const body = event('email.sent');
    const answer = await post(port, '/webhooks/resend', signed(body), body);
    assert.equal(answer.status, 200);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].payload.place, 'unread');
    assert.equal(facts[0].payload.key, 'change-not-in-shape');
  } finally {
    await close();
  }
});

test('an engine that does not take the fact makes the answer 503, so the service sends it again', async () => {
  const { port, close } = await serve({ arrive: async () => { throw new Error('the engine refused the fact: busy'); } });
  try {
    const body = event();
    const answer = await post(port, '/webhooks/resend', signed(body), body);
    assert.equal(answer.status, 503);
    assert.match(answer.json.reason, /busy/);
  } finally {
    await close();
  }
});

test('a config that names no real rule, port or secret is refused by the field it gets wrong', () => {
  const base = { ...CONFIG };
  assert.throws(() => receiverConfigOf({ ...base, verify: 'no-such-rule' }), { reason: 'unknown-verify-rule' });
  assert.throws(() => receiverConfigOf({ ...base, listen_port: 70000 }), { reason: 'bad-listen-port' });
  assert.throws(() => receiverConfigOf({ ...base, secret_credential: '../escape' }), { reason: 'bad-secret-credential' });
  assert.throws(() => receiverConfigOf({ ...base, path: 'webhooks' }), { reason: 'bad-path' });
});

test('the unit reads its secret from its credential file and tells each fact through the engine door', async () => {
  const doorCalls = [];
  const door = createHttpServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const call = JSON.parse(text);
      doorCalls.push({ auth: req.headers.authorization, method: call.params.arguments.method, input: call.params.arguments.input });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { structuredContent: {} } }));
    });
  });
  await new Promise((resolve) => door.listen(0, '127.0.0.1', resolve));
  const fixture = mkdtempSync(path.join(tmpdir(), 'receiver-unit-'));
  const credentials = path.join(fixture, 'credentials');
  mkdirSync(credentials);
  writeFileSync(path.join(credentials, 'resend-webhook-signing-secret'), `${SECRET}\n`);
  writeFileSync(path.join(fixture, 'door.json'), JSON.stringify({ url: `http://127.0.0.1:${door.address().port}/`, resource: '@own-records', capability: 'made-up-capability' }));
  const configPath = path.join(fixture, 'receiver.json');
  writeFileSync(configPath, JSON.stringify({ ...CONFIG, listen_port: 0, door_file: path.join(fixture, 'door.json') }));
  const server = await startReceiver({ configPath, env: { CREDENTIALS_DIRECTORY: credentials }, say: () => {} });
  try {
    const body = event();
    // The unit checks the replay window against the real clock, so this call is signed now.
    const answer = await post(server.address().port, '/webhooks/resend', signed(body, { ts: Math.floor(Date.now() / 1000) }), body);
    assert.equal(answer.status, 200);
    assert.equal(doorCalls.length, 1);
    assert.equal(doorCalls[0].auth, 'Bearer made-up-capability');
    assert.equal(doorCalls[0].method, 'wake:arrive');
    assert.equal(doorCalls[0].input.kind, 'resend-email-event');
    assert.equal(doorCalls[0].input.payload.key, 'em_1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => door.close(resolve));
    rmSync(fixture, { recursive: true, force: true });
  }
});
