// The sender against the fake records door and a stand-in place: a held value reaches only the place's own host and
// only as the request leaves, a destination is marked not known before the send, and nothing is sent twice. Every
// account and value here is made up; no request leaves this computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import places from '../read-data/post-places.json' with { type: 'json' };
import { heldFetch, sendAPost } from '../read-data/send-a-post.mjs';
import { heldFields } from '../read-data/posts.mjs';

const VALUE = 'made-up-held-value-0123456789';
const ACCOUNT = 'service_connection:x:second';
const connection = { id: `connection:${encodeURIComponent(ACCOUNT)}`, type: 'connection', value: { connection_id: ACCOUNT, vendor: 'x', plain: { user_id: '1000000001' }, held: ['access_token'] } };
const post = fields => ({ id: 'post:p1', type: 'post', value: { post_id: 'post:p1', status: 'scheduled', caption: 'A short post', destinations: [ACCOUNT], approved_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', scheduled_for: '2026-01-02T00:00:00Z', ...fields } });
const rights = [{ kind: 'post', operations: ['records:read', 'records:write'] }, { kind: 'connection', operations: ['records:read'] }];

// A stand-in for the place: answers a created post, and keeps every request it was sent.
function place(answer = { data: { id: '9001', text: 'A short post' } }) {
  const sent = [];
  const send = async (url, init) => {
    sent.push({ url, authorization: new Headers(init.headers).get('authorization'), body: init.body });
    return new Response(JSON.stringify(answer), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { sent, send };
}

async function withDoor(records, run) {
  const fake = await startFakeDoor({ rights, records });
  try { return await run(openRecordsDoor({ descriptor: fake.descriptor }), fake); } finally { await fake.close(); }
}

test('a post whose time has come is sent once to its destination, the held value only in the place\'s own request', async () => {
  const stand = place();
  await withDoor([post(), connection], async (door, fake) => {
    const sent = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door, send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
    assert.equal(stand.sent.length, 1);
    assert.equal(new URL(stand.sent[0].url).hostname, 'api.x.com');
    assert.equal(stand.sent[0].authorization, `Bearer ${VALUE}`);
    const kept = fake.kept.get('post:p1').value;
    assert.equal(kept.status, 'posted');
    assert.equal(kept.deliveries[ACCOUNT].status, 'posted');
    assert.equal(kept.deliveries[ACCOUNT].platform_post_id, '9001');
    assert.ok(!JSON.stringify([...fake.kept.values()]).includes(VALUE), 'the held value is in no record');
    // Sending again sends nothing: the destination already has the post.
    const again = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door, send: stand.send, held: () => VALUE });
    assert.match(again.said, /already has the post/);
    assert.equal(stand.sent.length, 1);
  });
});

test('nothing is sent before the post\'s time, for a draft, or to an account that is not its destination', async () => {
  const stand = place();
  await withDoor([post({ scheduled_for: '2099-01-01T00:00:00Z' }), connection], async door => {
    const early = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door, send: stand.send, held: () => VALUE });
    assert.match(early.said, /Its time has not come/);
  });
  await withDoor([post({ status: 'draft' }), connection], async door => {
    await assert.rejects(sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door, send: stand.send, held: () => VALUE }), /Only an approved post is sent/);
  });
  await withDoor([post(), connection], async door => {
    await assert.rejects(sendAPost({ post_id: 'post:p1', account_id: 'service_connection:x:other' }, { door, send: stand.send, held: () => VALUE }), /is not one of/);
  });
  assert.equal(stand.sent.length, 0);
});

test('a send whose outcome is not known is not sent again by itself, only with resend', async () => {
  const stand = place({ data: {} });
  await withDoor([post(), connection], async (door, fake) => {
    const first = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door, send: stand.send, held: () => VALUE });
    assert.equal(fake.kept.get('post:p1').value.deliveries[ACCOUNT].status, 'not known');
    assert.match(first.said, /not known/);
    const second = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door, send: stand.send, held: () => VALUE });
    assert.match(second.said, /not known/);
    assert.equal(stand.sent.length, 1);
    await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT, resend: true }, { door, send: stand.send, held: () => VALUE });
    assert.equal(stand.sent.length, 2);
  });
});

test('a post with a file is refused before anything leaves, in plain words', async () => {
  const stand = place();
  await withDoor([post({ media: { identity: 'sample-file', media_type: 'video/mp4' } }), connection], async (door, fake) => {
    const sent = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door, send: stand.send, held: () => VALUE });
    assert.equal(stand.sent.length, 0);
    assert.equal(fake.kept.get('post:p1').value.deliveries[ACCOUNT].status, 'failed');
    assert.match(sent.said, /cannot (read the person's files|make one for the person's file) yet/);
  });
});

test('a held value never goes to a host the place does not list, and a redirect carrying one is not followed', async () => {
  const standIns = new Map([['held-mark', () => VALUE]]);
  const seen = [];
  const fetchHeld = heldFetch({ standIns, hosts: ['api.x.com'], send: async (url, init) => { seen.push({ url, init }); return new Response('{}'); } });
  await assert.rejects(fetchHeld('https://elsewhere.example/steal', { headers: { authorization: 'Bearer held-mark' } }), /goes only to api\.x\.com/);
  await fetchHeld('https://api.x.com/2/tweets', { method: 'POST', headers: { authorization: 'Bearer held-mark' } });
  assert.equal(seen.length, 1);
  assert.equal(new Headers(seen[0].init.headers).get('authorization'), `Bearer ${VALUE}`);
  assert.equal(seen[0].init.redirect, 'manual');
});

test('each place\'s send row mounts the held fields its place signs with, in the order the sender reads them', () => {
  for (const row of rows.records.map(record => record.payload).filter(payload => payload.id.startsWith('tool:send-a-post-to-'))) {
    const placed = places.places.find(item => item.connection_vendor === row.invoke.connection.vendor);
    assert.ok(placed, `${row.id} names a place`);
    assert.deepEqual(row.invoke.credential_mounts, heldFields(placed.options).map((field, at) => ({ field_id: field, fd: 4 + at })));
    assert.equal(row.invoke.connection.from_input, 'account_id');
    assert.equal(row.invoke.internet, true);
  }
});
