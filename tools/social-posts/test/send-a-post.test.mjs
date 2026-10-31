// The sender against the fake records door and a stand-in place: a held value reaches only the place's own host and
// only as the request leaves, a destination is marked not known before the send, and nothing is sent twice. Every
// account and value here is made up; no request leaves this computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import places from '../read-data/post-places.json' with { type: 'json' };
import { heldFetch, sendAPost, sendEachPostAtItsTime } from '../read-data/send-a-post.mjs';
import { rowOf, runRow } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import settings from '../read-data/posts.json' with { type: 'json' };
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

// The person's files as the run's door answers them: one made-up picture, read a page at a time or shared as a link.
const PICTURE = new Uint8Array(Array.from({ length: 700 }, (_, at) => at % 251));
const SHARE_URL = 'https://files.example.test/bucket/people/p/files/sample-file?X-Amz-Signature=made-up';
function files({ gone = false, page = 256 } = {}) {
  const asked = [];
  const answer = async (operation, input) => {
    asked.push({ operation, input });
    if (gone) throw Object.assign(new Error('No file with that name or identity is in your namespace.'), { code: 'namespace_not_found' });
    if (operation === 'share_file') return { url: SHARE_URL, identity: 'sample-file', media_type: 'image/jpeg', byte_length: PICTURE.length, expires_at: '2026-01-02T06:00:00.000Z' };
    const bytes = PICTURE.subarray(input.offset, Math.min(input.offset + Math.min(input.length, page), PICTURE.length));
    return { identity: 'sample-file', media_type: 'image/png', byte_length: PICTURE.length, offset: input.offset, bytes_returned: bytes.length, encoding: 'base64', content: Buffer.from(bytes).toString('base64') };
  };
  return { asked, answer };
}
const withFiles = (door, held) => ({ ...door, files: held.answer });
const pictured = post({ media: { identity: 'sample-file', name: '/Posts/a.png', media_type: 'image/png', byte_length: PICTURE.length } });

test('a place that takes a file only whole is handed its bytes, read from the person\'s files a page at a time', async () => {
  const stand = place({ data: { id: '9001', text: 'A short post', media_id_string: '7001', media_id: '7001' }, media_id_string: '7001' });
  const held = files({ page: 256 });
  await withDoor([pictured, connection], async door => {
    await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door: withFiles(door, held), send: stand.send, held: () => VALUE });
    assert.deepEqual(held.asked.map(item => [item.operation, item.input.offset]), [['read_file', 0], ['read_file', 256], ['read_file', 512]]);
    assert.ok(held.asked.every(item => item.input.name_or_identity === 'sample-file'));
    assert.ok(stand.sent.every(request => new URL(request.url).hostname === 'api.x.com'), 'the file goes only to the place');
    const upload = stand.sent.find(request => request.body instanceof FormData || (request.body && typeof request.body.get === 'function'));
    assert.ok(upload, 'the picture was uploaded to the place');
    const sentBytes = new Uint8Array(await upload.body.get('media').arrayBuffer());
    assert.deepEqual(sentBytes, PICTURE);
  });
});

test('a place that fetches a file from an address is given a share of it, never the file', async () => {
  const instagram = 'service_connection:instagram:second';
  const record = { id: `connection:${encodeURIComponent(instagram)}`, type: 'connection', value: { connection_id: instagram, vendor: 'instagram', plain: { ig_user_id: '1000000002' }, held: ['access_token'] } };
  const stand = place({ id: '17890000000000001', status_code: 'FINISHED' });
  const held = files();
  await withDoor([post({ destinations: [instagram], media: { identity: 'sample-file', media_type: 'image/jpeg' } }), record], async door => {
    const sent = await sendAPost({ post_id: 'post:p1', account_id: instagram }, { door: withFiles(door, held), send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
    assert.deepEqual(held.asked, [{ operation: 'share_file', input: { name_or_identity: 'sample-file', seconds: 21600 } }]);
    assert.ok(stand.sent.length > 0);
    assert.ok(stand.sent.some(request => decodeURIComponent(`${request.url} ${request.body ?? ''}`).includes(SHARE_URL)), 'the place is handed the share');
    assert.ok(stand.sent.every(request => ['graph.instagram.com', 'graph.facebook.com'].includes(new URL(request.url).hostname)));
  });
});

test('a post whose file is gone from the person\'s files is refused before anything leaves, in plain words', async () => {
  const stand = place();
  await withDoor([pictured, connection], async (door, fake) => {
    const sent = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT }, { door: withFiles(door, files({ gone: true })), send: stand.send, held: () => VALUE });
    assert.equal(stand.sent.length, 0);
    assert.equal(fake.kept.get('post:p1').value.deliveries[ACCOUNT].status, 'failed');
    assert.match(sent.said, /no longer in your files, so nothing was sent to X/);
  });
});

test('each send row may share and read the person\'s files, and nothing else of them', () => {
  for (const record of rows.records.filter(item => item.payload.id.startsWith('tool:send-a-post-to-'))) {
    const filesRights = record.payload.invoke.records.rights.filter(right => 'files' in right);
    assert.deepEqual(filesRights, [{ files: '/', operations: ['share_file', 'read_file'] }], record.payload.id);
  }
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

// A post set to go at its time is sent then through the person's own wake: a change to their posts answers one timed
// run of the place's send row per destination, and that run sends only while the post carries the armed_at it was
// set with. The wake's cause is made up the way the engine hands one (task.cause.detail.changes).
const ARMED = '2026-01-01T00:00:05.000Z';
const armed = fields => post({ armed_at: ARMED, ...fields });
const changes = (...ids) => ({ cause: { kind: 'record', detail: { resource: 'own-records', changes: ids.map((id, at) => ({ id, sequence: at + 1, version: 1, deleted: false })) } } });
const timed = rowOf(rows, 'tool:send-each-post-at-its-time');

test('a post set to go at its time answers one timed send at that time, through the place\'s send row', async () => {
  const ran = await runRow(timed, { input: {}, task: changes('post:p1') }, { records: [armed(), connection] });
  assert.equal(ran.status, 0, JSON.stringify(ran));
  assert.deepEqual(ran.wake_effects, [{ wake: { tool: 'tool:send-a-post-to-x', at_ms: Date.parse('2026-01-02T00:00:00Z'), input: { post_id: 'post:p1', account_id: ACCOUNT, armed_at: ARMED }, budget: settings.at_its_time.child_budget } }]);
  assert.equal(ran.result.set.length, 1);
  assert.ok(!('wake_effects' in ran.result), 'the effects go to the engine, not into the answer');
  assert.deepEqual(ran.kept.find(record => record.id === 'post:p1').value, armed().value, 'the wake\'s run writes nothing');
});

test('a post going to two places answers two timed sends, one by each place\'s send row', async () => {
  const linkedin = 'service_connection:linkedin:second';
  const record = { id: `connection:${encodeURIComponent(linkedin)}`, type: 'connection', value: { connection_id: linkedin, vendor: 'linkedin', plain: { person_urn: 'urn:li:person:made-up' }, held: ['access_token'] } };
  const both = await sendEachPostAtItsTime({ task: changes('post:p1') }, { door: await doorOf([armed({ destinations: [ACCOUNT, linkedin] }), connection, record]) });
  assert.deepEqual(both.wake_effects.map(effect => [effect.wake.tool, effect.wake.input.account_id]), [['tool:send-a-post-to-x', ACCOUNT], ['tool:send-a-post-to-linkedin', linkedin]]);
});

test('a post not set to go, removed, or already sent to a destination answers no timed send there', async () => {
  for (const [label, records, task] of [
    ['a draft', [armed({ status: 'draft' }), connection], changes('post:p1')],
    ['approved but not set', [armed({ status: 'approved' }), connection], changes('post:p1')],
    ['removed', [connection], { cause: { detail: { changes: [{ id: 'post:p1', sequence: 1, version: 2, deleted: true }] } } }],
    ['already posted there', [armed({ deliveries: { [ACCOUNT]: { status: 'posted' } } }), connection], changes('post:p1')],
    ['not a record cause', [armed(), connection], {}],
  ]) {
    const answer = await sendEachPostAtItsTime({ task }, { door: await doorOf(records) });
    assert.deepEqual(answer.wake_effects, [], label);
    assert.equal(answer.said, settings.at_its_time.words.none, label);
  }
  const gone = await sendEachPostAtItsTime({ task: changes('post:p1') }, { door: await doorOf([armed()]) });
  assert.deepEqual(gone.left_out.map(item => item.said), [settings.at_its_time.words.not_connected], 'a destination no longer connected is named, not set');
});

test('a timed send set before the post was taken back, changed or set again sends nothing; one for its time sends', async () => {
  const stand = place();
  for (const [label, record] of [['set again', armed({ armed_at: '2026-01-01T09:00:00.000Z' })], ['taken back', armed({ status: 'draft' })], ['changed and approved again', armed({ status: 'approved' })]]) {
    await withDoor([record, connection], async (door, fake) => {
      const sent = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT, armed_at: ARMED }, { door, send: stand.send, held: () => VALUE });
      assert.equal(sent.said, settings.at_its_time.words.no_longer_set, label);
      assert.deepEqual(fake.kept.get('post:p1').value, record.value, `${label}: nothing was written`);
    });
  }
  await withDoor([connection], async door => {
    const sent = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT, armed_at: ARMED }, { door, send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'gone');
  });
  assert.equal(stand.sent.length, 0);
  await withDoor([armed(), connection], async door => {
    const sent = await sendAPost({ post_id: 'post:p1', account_id: ACCOUNT, armed_at: ARMED }, { door, send: stand.send, held: () => VALUE });
    assert.equal(sent.status, 'posted', sent.said);
  });
  assert.equal(stand.sent.length, 1);
});

test('the wake is the person\'s to switch on, on their posts, and grants exactly what the sends it sets need', () => {
  assert.deepEqual(timed.wakes.map(wake => [wake.id, wake.on]), [['at-its-time', { record: { resource: 'own-records', kind: 'post' } }]]);
  const plan = settings.at_its_time;
  assert.ok(timed.wakes[0].budget.steps >= 1 + plan.most_sends * plan.child_budget.steps && timed.wakes[0].budget.wall_ms >= (1 + plan.most_sends) * plan.child_budget.wall_ms, 'one firing pays for itself and every send it may set');
  assert.equal(timed.invoke.internet, false);
  assert.equal(timed.invoke.credential_mounts, undefined, 'the wake\'s run holds no account\'s values');
  const sendRows = rows.records.map(record => record.payload).filter(payload => payload.id.startsWith('tool:send-a-post-to-'));
  for (const row of sendRows) assert.deepEqual(timed.invoke.records.rights, row.invoke.records.rights, `${row.id}: a timed send reaches only what the wake was granted`);
  assert.deepEqual(places.places.map(item => item.send_tool).sort(), sendRows.map(row => row.id).sort(), 'every place is sent to by its own send row');
  for (const row of sendRows) assert.equal(row.input_schema.properties.armed_at.type, 'string', row.id);
});

const opened = [];
async function doorOf(records) {
  const fake = await startFakeDoor({ rights, records });
  opened.push(fake);
  return openRecordsDoor({ descriptor: fake.descriptor });
}
test.after(async () => { for (const fake of opened) await fake.close(); });
