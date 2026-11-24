// The signed webhook receiver with made-up secrets and calls: a good standard-webhooks call told as one fact, a bad
// signature refused and told to nobody, a replay told once, a wrong path, an oversized body and an unknown event type
// answered by their own codes, a 503 when the engine does not take the fact, and the unit's start: its two credentials,
// a missing key refused, and no key ever logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request, createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReceiver, receiverConfigOf, startReceiver } from '../do-work/signed-webhook-receiver.mjs';

const NOW = 1795050000000;
const SECRET = `whsec_${Buffer.from('made-up-receiver-key').toString('base64')}`;
const ACCOUNT_KEY = 'made-up-account-key';
const SHAPE = {
  place: { path: 'type' },
  change: { path: 'type', map: { 'thing.created': 'changed', 'thing.updated': 'changed', 'thing.tagged': 'changed', 'thing.archived': 'changed', 'thing.deleted': 'changed' } },
  key: ['data.thing_id'],
  at: ['data.created_at', 'created_at'],
  at_unit: 'iso',
};
const CONFIG = receiverConfigOf({
  listen_host: '127.0.0.1', listen_port: 0, path: '/webhooks/sample', secret_credential: 'sample-signing-secret',
  verify: 'standard-webhooks', shape: SHAPE, where: 'sample-service', kind: 'sample-event', door: 'http://127.0.0.1:7190',
});
const event = (type = 'thing.created', thing = 'th_1', created = '2026-11-21T19:00:00.000Z') =>
  JSON.stringify({ type, created_at: created, data: { thing_id: thing, created_at: created } });
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

function post(port, requestPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: requestPath, method: 'POST', headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (response) => {
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
    const answer = await post(port, '/webhooks/sample', signed(body), body);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { recorded: true, changes: 1, duplicates: 0 });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, 'sample-event');
    assert.equal(facts[0].event_id, 'sample-service:thing.created:th_1:changed:2026-11-21T19:00:00.000Z');
    assert.deepEqual(Object.keys(facts[0].payload).sort(), ['after', 'at', 'change', 'key', 'place', 'where']);
    assert.equal(facts[0].payload.key, 'th_1');
    assert.equal(facts[0].payload.place, 'thing.created');
    assert.equal(facts[0].payload.where, 'sample-service');
  } finally {
    await close();
  }
});

test('a bad signature is answered 401 and told to nobody', async () => {
  const { facts, port, close } = await serve();
  try {
    const body = event();
    const answer = await post(port, '/webhooks/sample', signed(body, { secret: `whsec_${Buffer.from('someone-else').toString('base64')}` }), body);
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
    const first = await post(port, '/webhooks/sample', signed(body), body);
    const second = await post(port, '/webhooks/sample', signed(body, { id: 'msg_1' }), body);
    assert.equal(first.json.duplicates, 0);
    assert.deepEqual(second.json, { recorded: true, changes: 1, duplicates: 1 });
    assert.equal(facts.length, 1);
  } finally {
    await close();
  }
});

test('a second update of the same thing, at a later time, is a different fact', async () => {
  const { facts, port, close } = await serve();
  try {
    const first = event('thing.updated', 'th_1', '2026-11-21T19:01:00.000Z');
    const second = event('thing.updated', 'th_1', '2026-11-21T19:02:00.000Z');
    await post(port, '/webhooks/sample', signed(first), first);
    await post(port, '/webhooks/sample', signed(second, { id: 'msg_2' }), second);
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
    const answer = await post(port, '/webhooks/sample', signed(body), body);
    assert.equal(answer.status, 413);
    assert.equal(facts.length, 0);
  } finally {
    await close();
  }
});

test('an event type the shape does not read is answered 200 and told as one refused fact', async () => {
  const { facts, port, close } = await serve();
  try {
    const body = event('thing.sent');
    const answer = await post(port, '/webhooks/sample', signed(body), body);
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
    const answer = await post(port, '/webhooks/sample', signed(body), body);
    assert.equal(answer.status, 503);
    assert.match(answer.json.reason, /busy/);
  } finally {
    await close();
  }
});

test('a config that names no real rule, port, secret or door is refused by the field it gets wrong', () => {
  const base = { ...CONFIG };
  assert.throws(() => receiverConfigOf({ ...base, verify: 'no-such-rule' }), { reason: 'unknown-verify-rule' });
  assert.throws(() => receiverConfigOf({ ...base, listen_port: 70000 }), { reason: 'bad-listen-port' });
  assert.throws(() => receiverConfigOf({ ...base, secret_credential: '../escape' }), { reason: 'bad-secret-credential' });
  assert.throws(() => receiverConfigOf({ ...base, path: 'webhooks' }), { reason: 'bad-path' });
  assert.throws(() => receiverConfigOf({ ...base, door: 'localhost:7190' }), { reason: 'bad-door-address' });
  assert.throws(() => receiverConfigOf({ ...base, door: 'http://name:secret@example.test' }), { reason: 'bad-door-address' });
  assert.throws(() => receiverConfigOf({ ...base, replay_window_seconds: 0 }), { reason: 'bad-replay-window' });
  assert.throws(() => receiverConfigOf({ ...base, health_path: base.path }), { reason: 'bad-health-path' });
});

/** A stand-in engine door: it records each door call's bearer and method, and answers the call as taken. */
async function standInDoor() {
  const calls = [];
  const door = createHttpServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const call = JSON.parse(text);
      calls.push({ auth: req.headers.authorization, method: call.params.arguments.method, input: call.params.arguments.input });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { structuredContent: {} } }));
    });
  });
  await new Promise((resolve) => door.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${door.address().port}/`, close: () => new Promise((resolve) => door.close(resolve)) };
}

/** A unit's credential folder and config on disk, for one start. */
function unitFixture({ withAccountKey = true } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'receiver-unit-'));
  const credentials = path.join(fixture, 'credentials');
  mkdirSync(credentials);
  writeFileSync(path.join(credentials, 'sample-signing-secret'), `${SECRET}\n`);
  if (withAccountKey) writeFileSync(path.join(credentials, 'account-key'), `${ACCOUNT_KEY}\n`);
  const configPath = path.join(fixture, 'receiver.json');
  return { fixture, credentials, configPath };
}

test('the unit reads its secret and its account key from its credential folder, and tells each fact through the door in the config', async () => {
  const door = await standInDoor();
  const unit = unitFixture();
  writeFileSync(unit.configPath, JSON.stringify({ ...CONFIG, listen_port: 0, door: door.url }));
  const says = [];
  const server = await startReceiver({ configPath: unit.configPath, env: { CREDENTIALS_DIRECTORY: unit.credentials }, say: (line) => says.push(line) });
  try {
    const body = event();
    // The unit checks the replay window against the real clock, so this call is signed now.
    const answer = await post(server.address().port, '/webhooks/sample', signed(body, { ts: Math.floor(Date.now() / 1000) }), body);
    assert.equal(answer.status, 200);
    assert.equal(door.calls.length, 1);
    assert.equal(door.calls[0].auth, `Bearer ${ACCOUNT_KEY}`);
    assert.equal(door.calls[0].method, 'wake:arrive');
    assert.equal(door.calls[0].input.kind, 'sample-event');
    assert.equal(door.calls[0].input.payload.key, 'th_1');
    assert.ok(says.every((line) => !line.includes(ACCOUNT_KEY) && !line.includes(SECRET)), 'no log line carries a key or the secret');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await door.close();
    rmSync(unit.fixture, { recursive: true, force: true });
  }
});

test('a unit without its account key refuses to start, and the refusal names the credential but not its value', async () => {
  const unit = unitFixture({ withAccountKey: false });
  writeFileSync(unit.configPath, JSON.stringify({ ...CONFIG, listen_port: 0, door: 'http://127.0.0.1:7190' }));
  try {
    await assert.rejects(
      startReceiver({ configPath: unit.configPath, env: { CREDENTIALS_DIRECTORY: unit.credentials }, say: () => {} }),
      (error) => /account-key/.test(error.message) && !error.message.includes(ACCOUNT_KEY),
    );
  } finally {
    rmSync(unit.fixture, { recursive: true, force: true });
  }
});


test('the DATA replay window rejects an old signature before any fact is told', async () => {
  const config = receiverConfigOf({ ...CONFIG, replay_window_seconds: 120 });
  const { facts, port, close } = await serve({ config });
  try {
    const body = event();
    const answer = await post(port, config.path, signed(body, { ts: Math.floor(NOW / 1000) - 121 }), body);
    assert.equal(answer.status, 401);
    assert.equal(answer.json.reason, 'outside-replay-window');
    assert.equal(facts.length, 0);
  } finally {
    await close();
  }
});

test('concurrent repeats share one in-flight acceptance, not two facts', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { facts, port, close } = await serve({ arrive: async () => gate });
  try {
    const body = event();
    const calls = [post(port, CONFIG.path, signed(body), body), post(port, CONFIG.path, signed(body), body)];
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const answers = await Promise.all(calls);
    assert.deepEqual(answers.map((answer) => answer.status), [200, 200]);
    assert.equal(facts.length, 1);
    assert.equal(answers.reduce((sum, answer) => sum + answer.json.duplicates, 0), 1);
  } finally {
    release();
    await close();
  }
});

test('a failed acceptance is not remembered, so the same event is retried', async () => {
  let attempts = 0;
  const { port, close } = await serve({ arrive: async () => { if (++attempts === 1) throw new Error('busy'); } });
  try {
    const body = event();
    assert.equal((await post(port, CONFIG.path, signed(body), body)).status, 503);
    assert.equal((await post(port, CONFIG.path, signed(body), body)).status, 200);
    assert.equal(attempts, 2);
  } finally {
    await close();
  }
});

test('health readback shows successful engine acceptance without event bodies or credentials', async () => {
  const { port, close } = await serve();
  try {
    const health = async () => {
      const response = await fetch(`http://127.0.0.1:${port}${CONFIG.health_path}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await health(), { ready: true, accepted: 0, last_accepted_at: null });
    const body = event();
    await post(port, CONFIG.path, signed(body), body);
    assert.deepEqual(await health(), { ready: true, accepted: 1, last_accepted_at: new Date(NOW).toISOString() });
  } finally {
    await close();
  }
});

test('an upstream error cannot leak either credential in the reply or the unit log', async () => {
  const unit = unitFixture();
  const says = [];
  writeFileSync(unit.configPath, JSON.stringify(CONFIG));
  const server = await startReceiver({
    configPath: unit.configPath,
    env: { CREDENTIALS_DIRECTORY: unit.credentials },
    fetchImpl: async () => { throw new Error(`upstream failed ${ACCOUNT_KEY} ${SECRET}`); },
    say: (line) => says.push(line),
  });
  try {
    const body = event();
    const answer = await post(server.address().port, CONFIG.path, signed(body, { ts: Math.floor(Date.now() / 1000) }), body);
    assert.equal(answer.status, 503);
    for (const text of [...says, JSON.stringify(answer.json)]) {
      assert.ok(!text.includes(ACCOUNT_KEY) && !text.includes(SECRET));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(unit.fixture, { recursive: true, force: true });
  }
});
