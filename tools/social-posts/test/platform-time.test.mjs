// A post set to go at a time: a place that takes the time itself (post-places.json `platform_time`) gets the post now with
// that time, and Ghost, the Facebook Page and YouTube keep it as their own scheduled time; a place without it waits for its
// run. Every account and value here is made up; no request leaves this computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendAPost as sendAPostRun } from '../read-data/send-a-post.mjs';
import { facebookPage } from '../read-data/publisher-facebook-page.mjs';

const VALUE = 'made-up-id:0123456789abcdef0123456789abcdef';
const GHOST = 'service_connection:ghost:blog';
const X = 'service_connection:x:second';
const AT = '2026-11-20T09:00:00.000Z';
const NOW = () => new Date('2026-11-19T12:00:00.000Z');
const ghostConnection = { id: `connection:${encodeURIComponent(GHOST)}`, type: 'connection', value: { connection_id: GHOST, vendor: 'ghost', plain: { site_url: 'https://blog.example.test' }, held: ['admin_api_key'] } };
const xConnection = { id: `connection:${encodeURIComponent(X)}`, type: 'connection', value: { connection_id: X, vendor: 'x', plain: { user_id: '1000000001' }, held: ['access_token'] } };
const post = fields => ({ id: 'post:p1', type: 'post', value: { post_id: 'post:p1', status: 'scheduled', caption: 'A short post', destinations: [GHOST], approved_at: '2026-11-18T00:00:00Z', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', scheduled_for: AT, ...fields } });

// A stand-in for the place: answers every request with the same body and keeps each request it was sent.
function place(answer) {
  const sent = [];
  const send = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { sent, send };
}

// The records the run is handed, kept as the caller keeps them: the answer's kept rows go back into the store.
async function sendAPost(store, input, context) {
  const answer = await sendAPostRun({ ...input, records: [...store.values()] }, context);
  for (const row of answer.keep ?? []) store.set(row.id, { id: row.id, type: row.type, value: row.value });
  return answer;
}

test('a Ghost post set to go at a time is created scheduled at that time, so Ghost publishes it while this computer sleeps', async () => {
  const stand = place({ posts: [{ id: 'g1', status: 'scheduled', updated_at: '2026-11-19T12:00:00.000Z' }] });
  const kept = new Map([[ghostConnection.id, ghostConnection], ['post:p1', post()]]);
  const answer = await sendAPost(kept, { post_id: 'post:p1', place: 'ghost', account_id: GHOST }, { send: stand.send, held: () => VALUE, now: NOW });
  assert.equal(stand.sent.length, 2, 'the create and the read back');
  const created = JSON.parse(stand.sent[0].body).posts[0];
  assert.equal(created.status, 'scheduled');
  assert.equal(created.published_at, AT);
  assert.equal(kept.get('post:p1').value.deliveries[GHOST].status, 'on its way', answer.said);
});

test('a Ghost post with no time is created published, with no published_at key', async () => {
  const stand = place({ posts: [{ id: 'g1', status: 'published', updated_at: '2026-11-19T12:00:00.000Z' }] });
  const kept = new Map([[ghostConnection.id, ghostConnection], ['post:p1', post({ scheduled_for: undefined, status: 'approved' })]]);
  const answer = await sendAPost(kept, { post_id: 'post:p1', place: 'ghost', account_id: GHOST }, { send: stand.send, held: () => VALUE, now: NOW });
  const created = JSON.parse(stand.sent[0].body).posts[0];
  assert.equal(created.status, 'published');
  assert.ok(!('published_at' in created));
  assert.equal(kept.get('post:p1').value.deliveries[GHOST].status, 'posted', answer.said);
});

test('a place without a platform time waits for its own run: an early send is refused and nothing is sent', async () => {
  const stand = place({});
  const kept = new Map([[xConnection.id, xConnection], ['post:p1', post({ destinations: [X], status: 'approved' })]]);
  const answer = await sendAPost(kept, { post_id: 'post:p1', place: 'x', account_id: X }, { send: stand.send, held: () => VALUE, now: NOW });
  assert.equal(stand.sent.length, 0);
  assert.match(answer.said, /Its time has not come/);
});

test('a Facebook Page post set to go at a time is created unpublished with its unix time, and a time under 10 minutes ahead is refused', async () => {
  const requests = [];
  const send = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'page_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const backend = facebookPage({ auth: { accessToken: VALUE }, pageId: '100', fetch: send }).posts;
  const account = { backend: 'default', platform: 'facebook', accountId: '100' };
  const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(backend.prepareTarget({ targetIndex: 0, account, content: { text: 'Hi', media: [] }, schedule: { at: later } }), []);
  const outcome = await backend.publishTarget({ targetIndex: 0, account, content: { text: 'Hi', media: [] }, schedule: { at: later } });
  assert.equal(outcome.state, 'scheduled');
  assert.equal(requests[0].body.published, false);
  assert.equal(requests[0].body.scheduled_publish_time, Math.floor(Date.parse(later) / 1000));
  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  const issues = backend.prepareTarget({ targetIndex: 0, account, content: { text: 'Hi', media: [] }, schedule: { at: soon } });
  assert.deepEqual(issues.map(issue => issue.code), ['schedule.range']);
});
