// The subscribe handshake and the nested comment walk, with made-up tokens and payloads: a good handshake is answered with its
// challenge as plain text; a wrong token, a wrong mode, a missing challenge and a config naming no real credential are refused;
// a signed call whose entries hold comment changes and feed changes tells only the comments, each at its entry's time, and
// a call with no comment change tells nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { createReceiver, receiverConfigOf } from '../do-work/signed-webhook-receiver.mjs';
import { changesOf } from '../do-work/mechanisms/signed-service-calls.mjs';

const NOW = 1795050000000;
const APP_SECRET = 'made-up-comment-app-secret';
const TOKEN = 'made-up-subscribe-token';
const SUBSCRIBE = { mode: 'subscribe', token: TOKEN };
const SHAPE = {
  levels: [{ list: 'entry' }, { list: 'changes', inherit: { entry_time: 'time' } }],
  filter: { path: 'field', equals: 'comments' },
  place: { value: 'comment' },
  change: { otherwise: 'added' },
  key: 'value.id',
  at: 'entry_time',
  at_unit: 'seconds',
  after: 'value',
};
const CONFIG = receiverConfigOf({
  listen_host: '127.0.0.1', listen_port: 0, path: '/webhooks/comments', secret_credential: 'comment-app-secret',
  verify: 'meta-x-hub-signature-256', shape: SHAPE, where: "comment-source", kind: 'comment-changed', door: 'http://127.0.0.1:7190',
  subscribe: { mode: 'subscribe', verify_credential: 'comment-subscribe-token' },
});
const signedCall = (body) => ({
  'content-type': 'application/json',
  'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`,
});

async function serve({ subscribe = SUBSCRIBE, arrive = async () => {} } = {}) {
  const facts = [];
  const server = createReceiver({
    config: CONFIG, secret: APP_SECRET, subscribe, now: () => NOW,
    arrive: async (fact) => { facts.push(fact); await arrive(fact); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { facts, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function call(port, method, requestPath, headers, body = '') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: requestPath, method, headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const handshake = (params) => `/webhooks/comments?${new URLSearchParams(params).toString()}`;

test('a good subscribe handshake is answered 200 with the challenge as plain text, and tells nothing', async () => {
  const { port, close, facts } = await serve();
  try {
    const answer = await call(port, 'GET', handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' }));
    assert.equal(answer.status, 200);
    assert.equal(answer.text, '1158201444');
    assert.equal(facts.length, 0);
  } finally {
    await close();
  }
});

test('a wrong token, a wrong mode and a missing challenge are each refused 403, naming nothing of the token', async () => {
  const { port, close } = await serve();
  try {
    const wrongToken = await call(port, 'GET', handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'made-up-other', 'hub.challenge': '1' }));
    const wrongMode = await call(port, 'GET', handshake({ 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' }));
    const noChallenge = await call(port, 'GET', handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN }));
    const noToken = await call(port, 'GET', handshake({ 'hub.mode': 'subscribe', 'hub.challenge': '1' }));
    for (const answer of [wrongToken, wrongMode, noChallenge, noToken]) {
      assert.equal(answer.status, 403);
      assert.ok(!answer.text.includes(TOKEN));
      assert.equal(JSON.parse(answer.text).reason, 'subscribe-refused');
    }
  } finally {
    await close();
  }
});

test('a GET on the path is answered 405 when the service has no subscribe handshake', async () => {
  const { port, close } = await serve({ subscribe: null });
  try {
    const answer = await call(port, 'GET', handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' }));
    assert.equal(answer.status, 405);
  } finally {
    await close();
  }
});

test('a subscribe config with a bad mode or a credential name that is not a name is refused by the field', () => {
  const base = { listen_host: '127.0.0.1', listen_port: 0, path: '/w', secret_credential: 's', verify: 'meta-x-hub-signature-256', shape: SHAPE, where: 'x', kind: 'k', door: 'http://127.0.0.1:7190' };
  assert.throws(() => receiverConfigOf({ ...base, subscribe: { mode: '', verify_credential: 'comment-subscribe-token' } }), /bad-subscribe/);
  assert.throws(() => receiverConfigOf({ ...base, subscribe: { mode: 'subscribe', verify_credential: 'has a space' } }), /bad-subscribe/);
  assert.equal(receiverConfigOf({ ...base, subscribe: { mode: 'subscribe', verify_credential: 'comment-subscribe-token' } }).subscribe.mode, 'subscribe');
});

test('a signed call with comment and feed changes in nested entries tells only the comments, each at its entry time', async () => {
  const { port, close, facts } = await serve();
  try {
    const body = JSON.stringify({
      object: 'page',
      entry: [
        { id: 'made-up-page-1', time: 1795049000, changes: [
          { field: 'comments', value: { id: 'made-up-comment-1', text: 'made-up text one' } },
          { field: 'feed', value: { id: 'made-up-post-1', item: 'post' } },
        ] },
        { id: 'made-up-page-2', time: 1795049500, changes: [
          { field: 'feed', value: { id: 'made-up-post-2', item: 'post' } },
          { field: 'comments', value: { id: 'made-up-comment-2', text: 'made-up text two' } },
        ] },
      ],
    });
    const answer = await call(port, 'POST', '/webhooks/comments', signedCall(body), body);
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { recorded: true, changes: 2, duplicates: 0 });
    assert.equal(facts.length, 2);
    assert.deepEqual(facts.map((fact) => fact.payload.key), ['made-up-comment-1', 'made-up-comment-2']);
    assert.deepEqual(facts.map((fact) => fact.payload.at), ['2026-11-19T00:43:20.000Z', '2026-11-19T00:51:40.000Z']);
    assert.ok(facts.every((fact) => fact.payload.place === 'comment' && fact.payload.where === "comment-source"));
  } finally {
    await close();
  }
});

test('a call whose entries hold no comment change is answered 200 with no change told', async () => {
  const { port, close, facts } = await serve();
  try {
    const body = JSON.stringify({ object: 'page', entry: [{ id: 'made-up-page-3', time: 1795049000, changes: [{ field: 'feed', value: { id: 'made-up-post-3' } }] }] });
    const answer = await call(port, 'POST', '/webhooks/comments', signedCall(body), body);
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { recorded: true, changes: 0, duplicates: 0 });
    assert.equal(facts.length, 0);
  } finally {
    await close();
  }
});

test('the nested walk reads a body whose nested list is missing as the shape\'s refusal, not as a crash', () => {
  const read = changesOf({ shape: SHAPE, where: "comment-source", body: JSON.stringify({ object: 'page', entry: [{ id: 'made-up-page-4', time: 1795049000 }] }), receivedAt: new Date(NOW) });
  assert.equal(read.refused, 'no-changes-at-path');
});
