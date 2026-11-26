import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readWebhookEvent } from '../do-work/read-a-webhook-event.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(payload => payload.id === 'tool:read-a-webhook-event');
const canary = 'held-key-canary-0123456789';
const webhook = '00000000-0000-4000-8000-000000000011';
const event = 'msg_1srOsB4mXhCqCVwAxYRNnpFZhb3';
const addressCanary = 'someone-canary@example.org';
const answering = (status, body) => async (address, request) => {
  assert.equal(address, `https://api.resend.com/webhooks/${webhook}/events/${event}`);
  assert.equal(request.headers.Authorization, `Bearer ${canary}`);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};
const bounced = {
  object: 'webhook_event', id: event, type: 'email.bounced', created_at: '2026-11-22T13:13:02.348Z', status: 'failed', next_attempt_at: null,
  payload: { type: 'email.bounced', created_at: '2026-11-22T13:13:02.348Z', data: {
    email_id: '00000000-0000-4000-8000-000000000031', to: [addressCanary], subject: 'Subject canary',
    bounce: { message: 'Mailbox does not exist', subType: 'General', type: 'Permanent' } } },
};

test('the row hands the held key on a private pipe, the input on stdin, reads only, and runs on the person\'s computer', () => {
  assert.ok(row, 'tools/email-sending-domains/tool-rows.json has tool:read-a-webhook-event');
  assert.deepEqual(row.invoke.credential_mounts, [{ secret_name_from_input: 'key_name', fd: 3 }]);
  assert.deepEqual(row.invoke.stdin, { fill: { from: 'input' } });
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.deepEqual(row.input_schema.required, ['key_name', 'webhook_id', 'event_id']);
  assert.deepEqual(row.verify[0].replies.map(reply => reply.request), [{ method: 'GET', url: `https://api.resend.com/webhooks/${webhook}/events/${event}` }]);
});

test('answers the event\'s type, time, status, email and bounce type, never the key, an address or the subject', async () => {
  const answer = await readWebhookEvent({ key: `${canary}\n`, webhook_id: webhook, event_id: event, fetchImpl: answering(200, bounced) });
  assert.deepEqual(answer, { id: event, type: 'email.bounced', created_at: '2026-11-22T13:13:02.348Z', status: 'failed', email_id: '00000000-0000-4000-8000-000000000031', bounce: { type: 'Permanent', sub_type: 'General' } });
  const said = JSON.stringify(answer);
  assert.ok(!said.includes(canary) && !said.includes(addressCanary) && !said.includes('Subject canary'), 'no key, address or subject is answered');
});

test('an event with no bounce answers bounce null; ids of the wrong shape are refused before anything is asked', async () => {
  const delivered = { ...bounced, type: 'email.delivered', payload: { type: 'email.delivered', data: { email_id: 'e-1', to: [addressCanary] } } };
  assert.equal((await readWebhookEvent({ key: canary, webhook_id: webhook, event_id: event, fetchImpl: answering(200, delivered) })).bounce, null);
  await assert.rejects(readWebhookEvent({ key: canary, webhook_id: '../emails', event_id: event, fetchImpl: () => assert.fail('nothing is asked') }), /letters, digits and dashes only/);
  await assert.rejects(readWebhookEvent({ key: canary, webhook_id: webhook, event_id: 'evt/../x', fetchImpl: () => assert.fail('nothing is asked') }), /starts msg_/);
});

test('a refused or missing key, or an unknown event, says what to do, without the key', async () => {
  await assert.rejects(readWebhookEvent({ key: canary, webhook_id: webhook, event_id: event, fetchImpl: answering(401, {}) }), error => /Connect the account again/.test(error.message) && !error.message.includes(canary));
  await assert.rejects(readWebhookEvent({ key: canary, webhook_id: webhook, event_id: event, fetchImpl: answering(404, {}) }), /has no event/);
  await assert.rejects(readWebhookEvent({ key: canary, webhook_id: webhook, event_id: event, fetchImpl: answering(500, {}) }), /answered 500\. Try again later/);
  await assert.rejects(readWebhookEvent({ key: '', webhook_id: webhook, event_id: event, fetchImpl: answering(200, {}) }), /Connect the email-sending account first/);
});
