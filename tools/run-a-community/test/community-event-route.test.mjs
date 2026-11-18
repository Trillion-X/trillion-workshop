import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunityEventRoute, nativeCommunityTask, nativeCommunityResponse } from '../do-work/community-event-route.mjs';

const accountTask = () => ({
  task_id: 'synthetic-route-request', request_key: 'synthetic-route-request',
  context: { account_id: 'holder', admission: 'account', actor: { kind: 'account', id: 'holder' } },
});

test('route task reader uses native context and retains only the admitted actor evidence', () => {
  const task = accountTask();
  task.account_id = 'forged-holder';
  task.grant_person = 'forged-person';
  task.actor = { kind: 'person', id: 'forged-person' };
  const context = nativeCommunityTask(task);
  assert.equal(context.account_id, 'holder');
  assert.deepEqual(context.actor, { kind: 'account', id: 'holder' });
  assert.equal(context.request_key, 'synthetic-route-request');
  assert.equal('grant_person' in context, false);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.actor), true);
});

test('route task reader keeps a disclosed share person distinct from the holder account', () => {
  const task = accountTask();
  task.context = { account_id: 'holder', admission: 'share_act', actor: { kind: 'person', id: 'actual-person' } };
  assert.deepEqual(nativeCommunityTask(task).actor, { kind: 'person', id: 'actual-person' });
});

test('route task reader preserves withheld identity without manufacturing an actor', () => {
  const task = accountTask();
  task.context = { account_id: 'holder', admission: 'share_act' };
  task.grant_person = 'untrusted-person';
  task.actor = { kind: 'account', id: 'holder' };
  assert.equal('actor' in nativeCommunityTask(task), false);
});

test('route task reader refuses missing, mismatched and malformed native evidence', () => {
  for (const task of [
    { task_id: 'key', request_key: 'key', account_id: 'holder', grant_person: 'person' },
    { ...accountTask(), task_id: 'another-task' },
    { ...accountTask(), context: { account_id: 'holder', admission: 'account', actor: { kind: 'account', id: 'another-holder' } } },
    { ...accountTask(), context: { account_id: 'holder', admission: 'share_act', actor: { kind: 'account', id: 'holder' } } },
    { ...accountTask(), context: { account_id: 'holder', admission: 'share_act', actor: {} } },
  ]) assert.throws(() => nativeCommunityTask(task), error => error.status === 503 && error.code === 'community_context_unavailable');
});

test('route composition refuses missing real records resource instead of deriving one from task or input', async () => {
  const task = accountTask();
  task.resource = 'forged-resource';
  await assert.rejects(createCommunityEventRoute({
    task, door: {}, resource: 'another-forged-resource',
  }), error => error.status === 503 && error.code === 'community_resource_unavailable');
});

test('native response preserves committed JSON outcome metadata', async () => {
  const body = { error: 'Synthetic delivery unavailable.', committed: true, result: { event_id: 'event-fixture', cancelled: true }, effect: 'calendars' };
  assert.deepEqual(await nativeCommunityResponse(Response.json(body, { status: 503 })), { status: 503, body });
});

test('native calendar transport preserves opaque UTF-8 body bytes using the generic text-file schema', async () => {
  const text = 'Opaque transport fixture\r\nUTF-8: é\r\n';
  const result = await nativeCommunityResponse(new Response(text, { headers: {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': 'attachment; filename="event.ics"',
  } }));
  assert.equal(result.body, text);
  assert.deepEqual(result.http, { format: 'text', content_type: 'text/calendar; charset=utf-8', download_name: 'event.ics' });
  assert.equal('headers' in result, false);
});

test('the first real read and create reach the space permission owner and answer, without a missing binding', async () => {
  const spaces = new Map([['space-1', { id: 'space-1', label: 'team', parent_id: null, created_by: 'owner', title: 'Shared learning', created_at: '2026-11-01T00:00:00.000Z' }]]);
  const members = new Map([['space-1|member-1', { membership_id: 'space-1', relay: 'member-1', role: 'member', state: 'member' }]]);
  const events = new Map();
  let rules = null;
  const records = {
    read: async id => spaces.get(id) ?? null, member: async (spaceId, relay) => members.get(`${spaceId}|${relay}`) ?? null,
    members: async spaceId => [...members.values()].filter(row => row.membership_id === spaceId),
    events: async parentId => [...events.values()].filter(row => row.parent_id === parentId),
    putEvents: async rows => { for (const row of rows) events.set(row.id, structuredClone(row)); },
    putMember: async () => {}, removeEvent: async id => { events.delete(id); },
    transaction: async run => run(), community: async () => null,
    rules: async () => rules, ensureRules: async (_id, row) => (rules ??= row), compareAndSetRules: async () => true,
    ownMemberTypes: async () => [],
  };
  const route = await createCommunityEventRoute({
    records, resource: 'space:space-1', membership_labels: { membership_labels: { team: { joined_by: 'invitation', configuration: { title: 'Shared learning', spaces: { events: 'members' } } } } },
    task: { task_id: 'synthetic-first-call', request_key: 'synthetic-first-call', context: { account_id: 'member-1', admission: 'account', actor: { kind: 'account', id: 'member-1' } } },
    current: async () => true, resolveIdentity: async () => ({ relay: 'member-1', holds: [] }),
    permissionOptions: () => ({ openToEveryone: async () => false, captureSpaceCommit: async () => {}, sourceAuthority: async () => false, memberNames: async () => relay => relay }),
    spaces: async () => ({ spaces: [{ space_id: 'space-1', title: 'Shared learning' }], complete: true }),
    spaceChanged: () => {}, tellEventCalendars: () => {}, tellMembersOfMeetingChange: async () => {}, calendarUidDomain: 'example.test',
    newId: prefix => prefix + '_first', acceptedInvitation: async () => false, readMailRow: async () => undefined,
  });
  const created = await route.request({ method: 'POST', path: '/community/space-1/events', body: { community_id: 'space-1', title: 'Meet', starts_at: '2026-11-10T22:00:00Z', ends_at: '2026-11-10T23:00:00Z' } });
  assert.equal(created.status, 200);
  const listed = await route.request({ method: 'GET', path: '/community/events', query: { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' } });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.events.map(event => event.event_id), [created.body.event_id]);
});
