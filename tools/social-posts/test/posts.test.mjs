// The posting rows (draft, check, approve, set for its time, take back, where a post can go) run as the container
// runs them, against the fake records door with exactly each row's rights. Every account here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { approveAPost } from '../read-data/posts.mjs';
import { approvalValues } from '../read-data/post-shape.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = id => rowOf(rows, `tool:${id}`);
const connection = value => ({ id: `connection:${encodeURIComponent(value.connection_id)}`, type: 'connection', value });
// A short-text place whose account is named by a readable field and signed with one held value.
const shortText = connection({ connection_id: 'service_connection:x:second', vendor: 'x', plain: { user_id: '1000000001' }, held: ['access_token'] });
// The same place, connected without the value it signs with.
const unsigned = connection({ connection_id: 'service_connection:x', vendor: 'x', plain: { user_id: '1000000002' }, held: [] });
// A video place whose account field is missing.
const video = connection({ connection_id: 'service_connection:instagram', vendor: 'instagram', plain: {}, held: ['access_token'] });
const accounts = [shortText, unsigned, video];
const AHEAD = '2099-06-01T09:00:00Z';

// Each run hands the next the records the door holds afterwards.
async function step(id, input, records) {
  const ran = await runRow(row(id), input, { records });
  return { ...ran, records: ran.kept };
}

test('where a post can go: each account ready or not and why, and each place with no account', async () => {
  const ran = await step('list-post-destinations', {}, accounts);
  assert.equal(ran.status, 0, ran.error);
  const byId = Object.fromEntries(ran.result.destinations.map(item => [item.account_id, item]));
  assert.equal(byId['service_connection:x:second'].ready, true);
  assert.match(byId['service_connection:x'].said, /holds no access token/);
  assert.match(byId['service_connection:instagram'].said, /does not say its ig user id/);
  assert.ok(ran.result.not_connected.some(item => item.platform === 'youtube'));
  assert.equal(ran.result.said, '3 accounts are connected for posting.');
});

test('a draft goes nowhere until it has destinations, and an account that is not the person\'s is refused', async () => {
  const draft = await step('draft-a-post', { caption: 'Words only, for now', drafted_by: 'Sample AI' }, accounts);
  assert.equal(draft.status, 0, draft.error);
  assert.equal(draft.result.post.status, 'draft');
  assert.equal(draft.result.ready.ready, false);
  assert.match(draft.result.ready.said, /Pick where it goes/);
  const kept = draft.records.filter(record => record.type === 'post');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, draft.result.post.post_id);
  assert.equal(kept[0].value.drafted_by, 'Sample AI');

  const stranger = await step('draft-a-post', { caption: 'Hello', destinations: ['service_connection:someone-else'] }, accounts);
  assert.equal(stranger.status, 1);
  assert.match(stranger.error, /is not an account this person can post to/);
});

test('draft, check, approve as reviewed, then set for its time: scheduled, nothing sent', async () => {
  const draft = await step('draft-a-post', { caption: 'A short post', destinations: ['service_connection:x:second'], scheduled_for: AHEAD, time_zone: 'America/New_York', link: 'https://example.com/join' }, accounts);
  assert.equal(draft.status, 0, draft.error);
  const { post_id: postId, approval_values: reviewed } = draft.result.post;
  assert.equal(draft.result.ready.ready, true);

  const check = await step('check-a-post', { post_id: postId }, draft.records);
  assert.equal(check.result.ready, true);
  assert.equal(check.result.destinations[0].said, 'Ready for X.');

  const early = await step('set-a-post-to-go-at-its-time', { post_id: postId }, draft.records);
  assert.equal(early.status, 1);
  assert.match(early.error, /Only an approved post is set to go/);

  const approved = await step('approve-a-post', { post_id: postId, expected_values: reviewed, approved_by: 'Sample AI' }, draft.records);
  assert.equal(approved.status, 0, approved.error);
  assert.equal(approved.result.post.status, 'approved');

  const set = await step('set-a-post-to-go-at-its-time', { post_id: postId }, approved.records);
  assert.equal(set.status, 0, set.error);
  assert.equal(set.result.status, 'scheduled');
  assert.match(set.result.said, /Nothing was sent now/);
  const kept = set.records.find(record => record.id === postId).value;
  assert.equal(kept.status, 'scheduled');
  assert.equal(kept.scheduled_for, '2099-06-01T09:00:00.000Z');
  assert.equal(kept.sent_at, undefined);
  assert.equal(kept.deliveries, undefined);
  assert.ok(kept.armed_at);
  assert.ok(set.records.filter(record => record.type === 'connection').every(record => accounts.some(account => JSON.stringify(account) === JSON.stringify(record))), 'connections are only read');

  const again = await step('set-a-post-to-go-at-its-time', { post_id: postId }, set.records);
  assert.match(again.result.said, /already set to go/);

  const back = await step('take-back-a-post', { post_id: postId }, set.records);
  assert.equal(back.status, 0, back.error);
  assert.equal(back.result.post.status, 'draft');
  assert.equal(back.records.find(record => record.id === postId).value.armed_at, undefined);
});

test('publish now queues the exact reviewed post through its existing wake and is idempotent', async () => {
  const draft = await step('draft-a-post', { caption: 'A post approved for now', destinations: ['service_connection:x:second'] }, accounts);
  const { post_id: postId, approval_values: reviewed } = draft.result.post;
  const approved = await step('approve-a-post', { post_id: postId, expected_values: reviewed }, draft.records);
  const publishNow = row('publish-a-post-now');
  assert.deepEqual(publishNow.input_schema.required, ['post_id', 'expected_values']);
  assert.equal(publishNow.invoke.internet, false, 'the queueing action sends no network request');
  assert.deepEqual(publishNow.invoke.records.rights, [
    { kind: 'post', operations: ['records:read', 'records:write'] },
    { kind: 'connection', operations: ['records:list'] },
  ]);

  const ungranted = structuredClone(publishNow);
  ungranted.invoke.records.rights = [{ kind: 'post', operations: ['records:read', 'records:write'] }];
  const denied = await runRow(ungranted, { post_id: postId, expected_values: reviewed }, { records: approved.records });
  assert.equal(denied.status, 1, 'the current records grant must allow checking destination connections');
  assert.equal(denied.kept.find(record => record.id === postId).value.status, 'approved');

  const queued = await runRow(publishNow, { post_id: postId, expected_values: reviewed }, { records: approved.records });
  assert.equal(queued.status, 0, queued.error);
  assert.equal(queued.result.status, 'scheduled');
  assert.equal(queued.result.ready.ready, true);
  assert.ok(Date.parse(queued.result.post.approval_values.scheduled_for) <= Date.now());
  assert.equal(queued.result.post.status, 'scheduled');
  assert.equal(queued.result.post.approved_at, approved.result.post.approved_at);
  assert.deepEqual(queued.result.post.destinations.map(item => item.status), ['not sent']);
  assert.match(queued.result.said, /Queued for the send wake.*did not send/);

  const again = await runRow(publishNow, { post_id: postId, expected_values: reviewed }, { records: queued.kept });
  assert.equal(again.status, 0, again.error);
  assert.equal(again.result.post.armed_at, queued.result.post.armed_at);
  assert.equal(again.result.post.updated_at, queued.result.post.updated_at);
  assert.equal(again.calls.filter(call => call.method === 'records:write').length, 0, 'a repeated request creates no second write or wake');

  const changed = await step('draft-a-post', { post_id: postId, caption: 'Different reviewed words' }, approved.records);
  const stale = await runRow(publishNow, { post_id: postId, expected_values: reviewed }, { records: changed.records });
  assert.equal(stale.status, 1);
  assert.match(stale.error, /changed after it was reviewed/);
  assert.equal(stale.kept.find(record => record.id === postId).value.status, 'draft');
});

test('publish now stays approved when a current destination connection is not ready', async () => {
  const draft = await step('draft-a-post', { caption: 'Wait for the account', destinations: ['service_connection:x'] }, accounts);
  const { post_id: postId, approval_values: reviewed } = draft.result.post;
  const approved = await step('approve-a-post', { post_id: postId, expected_values: reviewed }, draft.records);
  const result = await runRow(row('publish-a-post-now'), { post_id: postId, expected_values: reviewed }, { records: approved.records });
  assert.equal(result.status, 0, result.error);
  assert.equal(result.result.status, 'approved');
  assert.equal(result.result.ready.ready, false);
  assert.match(result.result.said, /not queued/);
  assert.match(result.result.ready.destinations[0].said, /holds no access token/);
  assert.equal(result.kept.find(record => record.id === postId).value.status, 'approved');
  assert.equal(result.kept.find(record => record.id === postId).value.armed_at, undefined);
});

test('changing a scheduled post makes it a draft again, and a stale review is refused', async () => {
  const draft = await step('draft-a-post', { caption: 'First words', destinations: ['service_connection:x:second'], scheduled_for: AHEAD }, accounts);
  const { post_id: postId, approval_values: reviewed } = draft.result.post;
  const approved = await step('approve-a-post', { post_id: postId, expected_values: reviewed }, draft.records);
  const set = await step('set-a-post-to-go-at-its-time', { post_id: postId }, approved.records);
  assert.equal(set.result.status, 'scheduled');

  const changed = await step('draft-a-post', { post_id: postId, caption: 'Other words' }, set.records);
  assert.equal(changed.status, 0, changed.error);
  assert.equal(changed.result.post.status, 'draft');
  assert.match(changed.result.said, /draft again/);

  const stale = await step('approve-a-post', { post_id: postId, expected_values: reviewed }, changed.records);
  assert.equal(stale.status, 1);
  assert.match(stale.error, /changed after it was reviewed/);
});

test('a post with no time ahead, or not ready for a place, is not set to go', async () => {
  const past = await step('draft-a-post', { caption: 'Late', destinations: ['service_connection:x:second'], scheduled_for: '2001-01-01T00:00:00Z' }, accounts);
  const pastApproved = await step('approve-a-post', { post_id: past.result.post.post_id, expected_values: past.result.post.approval_values }, past.records);
  const pastSet = await step('set-a-post-to-go-at-its-time', { post_id: past.result.post.post_id }, pastApproved.records);
  assert.equal(pastSet.status, 1);
  assert.match(pastSet.error, /no time still ahead/);

  const notReady = await step('draft-a-post', { caption: 'Needs a video', destinations: ['service_connection:x'], scheduled_for: AHEAD }, accounts);
  const notReadyApproved = await step('approve-a-post', { post_id: notReady.result.post.post_id, expected_values: notReady.result.post.approval_values }, notReady.records);
  const notReadySet = await step('set-a-post-to-go-at-its-time', { post_id: notReady.result.post.post_id }, notReadyApproved.records);
  assert.equal(notReadySet.status, 0, notReadySet.error);
  assert.equal(notReadySet.result.status, 'approved');
  assert.match(notReadySet.result.said, /It was not set to go\..*holds no access token/);
});

test('an AI can approve a named post exactly as reviewed under its row grant, without claiming page origin', async () => {
  const draft = await step('draft-a-post', { caption: 'Thanks @someone for the idea', destinations: ['service_connection:x:second'] }, accounts);
  const { post_id: postId, approval_values: reviewed } = draft.result.post;
  const approve = row('approve-a-post');
  assert.equal(approve.input_schema.additionalProperties, false);
  assert.ok(!('run_origin' in approve.invoke.stdin) && !('origin' in approve.input_schema.properties), 'the approval row does not invent or accept page origin');
  assert.deepEqual(approve.input_schema.required, ['post_id', 'expected_values']);
  assert.deepEqual(approve.invoke.records.rights, [{ kind: 'post', operations: ['records:read', 'records:write'] }]);

  const approved = await runRow(approve, { post_id: postId, expected_values: reviewed, approved_by: 'Sample AI' }, { records: draft.records });
  assert.equal(approved.status, 0, approved.error);
  assert.equal(approved.result.post.status, 'approved');
  assert.equal(approved.result.post.approved_by, 'Sample AI');
  assert.equal(approved.kept.find(record => record.id === postId).value.approved_from, undefined);

  const ungranted = structuredClone(approve);
  ungranted.invoke.records.rights[0].operations = ['records:read'];
  const denied = await runRow(ungranted, { post_id: postId, expected_values: reviewed }, { records: draft.records });
  assert.equal(denied.status, 1);
  assert.equal(denied.kept.find(record => record.id === postId).value.status, 'draft');
});

test('approval requires the complete reviewed values and refuses a named post after it changes', async () => {
  const draft = await step('draft-a-post', { caption: 'Thanks @someone for the idea', destinations: ['service_connection:x:second'] }, accounts);
  const { post_id: postId, approval_values: reviewed } = draft.result.post;
  const missingReview = await step('approve-a-post', { post_id: postId }, draft.records);
  assert.equal(missingReview.status, 1);
  assert.match(missingReview.error, /complete approval_values/);

  const changed = await step('draft-a-post', { post_id: postId, caption: 'Thanks @someone for the updated idea' }, draft.records);
  const stale = await step('approve-a-post', { post_id: postId, expected_values: reviewed }, changed.records);
  assert.equal(stale.status, 1);
  assert.match(stale.error, /changed after it was reviewed/);
  assert.equal(stale.records.find(record => record.id === postId).value.status, 'draft');
});

test('a concurrent caption edit after approval reads is overwritten by the unconditional whole-record write', async () => {
  const postId = 'post:race';
  const reviewedPost = {
    post_id: postId, status: 'draft', caption: 'Reviewed words', destinations: ['service_connection:x:second'],
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', scheduled_for: null,
  };
  const concurrentEdit = { ...reviewedPost, caption: 'Newer words from another run', updated_at: '2026-01-02T00:00:00.000Z' };
  const fake = await startFakeDoor({
    rights: [{ kind: 'post', operations: ['records:read', 'records:write'] }],
    records: [{ id: postId, type: 'post', value: reviewedPost }],
  });
  let interleaved = false;
  const fetchImpl = async (url, init) => {
    const call = JSON.parse(init.body).params.arguments;
    if (call.method === 'records:write' && !interleaved) {
      // Another tool run commits its edit after approveAPost's read and before this unconditional write arrives.
      fake.kept.set(postId, { id: postId, type: 'post', value: concurrentEdit });
      interleaved = true;
    }
    return fetch(url, init);
  };
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor, fetchImpl });
    const approved = await approveAPost(
      { post_id: postId, expected_values: approvalValues(reviewedPost) },
      { door, now: () => new Date('2026-01-03T00:00:00.000Z') },
    );
    const readback = await door.read('post', postId);
    assert.equal(interleaved, true);
    assert.equal(approved.post.status, 'approved');
    assert.equal(readback.caption, 'Reviewed words', 'the current door write overwrote the concurrent newer caption');
    assert.equal(readback.status, 'approved', 'the stale approval is now attached to the older caption');
    assert.equal(fake.calls.filter(call => call.method === 'records:write').length, 1);
  } finally {
    await fake.close();
  }
});

test('a check reports what it could not see as not checked, and a missing post as missing', async () => {
  const draft = await step('draft-a-post', {
    caption: 'A clip', destinations: ['service_connection:x:second'],
    media: { identity: 'sample-file-identity', name: 'clip.mp4', media_type: 'video/mp4', byte_length: 1000 },
  }, accounts);
  assert.equal(draft.status, 0, draft.error);
  const check = await step('check-a-post', { post_id: draft.result.post.post_id }, draft.records);
  assert.deepEqual(check.result.destinations[0].not_checked.map(item => item.check), ['media_found']);
  assert.equal(check.result.destinations[0].ready, true);

  const missing = await step('check-a-post', { post_id: 'post:that-is-not-there' }, accounts);
  assert.equal(missing.result.status, 'missing');
});

test('a bad time zone and a link that is not https are refused with what to give', async () => {
  const zone = await step('draft-a-post', { caption: 'x', time_zone: 'Not/AZone' }, accounts);
  assert.match(zone.error, /is not a time zone/);
  const link = await step('draft-a-post', { caption: 'x', link: 'http://example.com' }, accounts);
  assert.match(link.error, /full https address/);
});

test('each connection check asks with the value its place signs with, over https, and posts nothing', async () => {
  const { default: places } = await import('../read-data/post-places.json', { with: { type: 'json' } });
  const checks = rows.records.map(record => record.payload).filter(payload => payload.invoke.kind === 'http');
  assert.ok(checks.length >= 2);
  for (const check of checks) {
    const vendor = check.invoke.connection.vendor;
    const place = places.places.find(item => item.connection_vendor === vendor);
    assert.ok(place, `${check.id} checks a vendor some place posts through`);
    const signed = JSON.stringify(place.options);
    for (const item of check.invoke.credential_injections) assert.ok(signed.includes(`{"held":"${item.field_id}"}`), `${check.id} uses ${item.field_id}, which ${place.id} signs with`);
    assert.equal(check.invoke.method, 'GET');
    assert.equal(check.read_only, true);
    assert.ok(place.hosts.includes(new URL(check.invoke.url).hostname), `${check.id} asks one of ${place.id}'s own hosts`);
  }
});
