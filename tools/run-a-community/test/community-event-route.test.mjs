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
