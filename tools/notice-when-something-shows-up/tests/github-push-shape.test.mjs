// The GitHub push receiver (receivers/github-push.json): a push GitHub signs is read into the 7 fact fields the workflow
// workflow:keep-tool-copies-in-step is chosen by: where (the receiver's repo name), place (the pushed ref), change (changed),
// key (the pushed head sha, so GitHub's redelivery of one push is one fact), at (the head commit's time), before (the sha the
// ref moved from) and after (the repository's full name). The body is shaped as GitHub's push event is documented
// (https://docs.github.com/en/webhooks/webhook-events-and-payloads#push); the secret is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { changesOf } from '../do-work/mechanisms/signed-service-calls.mjs';
import { createReceiver, receiverConfigOf } from '../do-work/signed-webhook-receiver.mjs';

const config = receiverConfigOf(JSON.parse(readFileSync(new URL('../receivers/github-push.json', import.meta.url), 'utf8')));
const SECRET = 'made-up-github-webhook-secret';
const HEAD = '9f2c6d5e4b3a29180716f5e4d3c2b1a0f9e8d7c6';
const push = (ref = 'refs/heads/main', after = HEAD) => JSON.stringify({
  ref, before: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', after, created: false, deleted: false, forced: false,
  repository: { id: 1, name: 'my-registry-of-tools', full_name: 'example-owner/my-registry-of-tools', private: true },
  pusher: { name: 'someone' },
  commits: [{ id: after, message: 'Move the screen-look pointer', timestamp: '2026-11-28T01:10:00-06:00' }],
  head_commit: { id: after, message: 'Move the screen-look pointer', timestamp: '2026-11-28T01:10:00-06:00' },
});

test('a push is read into the seven fact fields', () => {
  const read = changesOf({ shape: config.shape, where: config.where, body: push() });
  assert.equal(read.changes.length, 1);
  assert.deepEqual(read.changes[0].detail, {
    where: 'github:registry-of-tools-we-use-from-trillion', place: 'refs/heads/main', change: 'changed',
    at: '2026-11-28T07:10:00.000Z', key: HEAD,
    before: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
    after: 'example-owner/my-registry-of-tools',
  });
});

test('a push to another branch is read the same way, with its own ref as place', () => {
  const read = changesOf({ shape: config.shape, where: config.where, body: push('refs/heads/x') });
  assert.equal(read.changes[0].detail.place, 'refs/heads/x');
});

test('the receiver tells one fact for a signed push, refuses a forged one, and tells a redelivery once', async (t) => {
  const told = [];
  const server = createReceiver({ config, secret: SECRET, arrive: async (fact) => { told.push(fact); return true; } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}${config.path}`;
  const send = (body, secret = SECRET) => fetch(url, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
  const body = push();
  assert.equal((await send(body)).status, 200);
  assert.equal((await send(body, 'not-the-secret')).status, 401);
  const again = await send(body);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicates, 1);
  assert.equal(told.length, 1);
  assert.equal(told[0].kind, 'something-changed');
  assert.equal(told[0].payload.key, HEAD);
  assert.equal(told[0].payload.place, 'refs/heads/main');
});
