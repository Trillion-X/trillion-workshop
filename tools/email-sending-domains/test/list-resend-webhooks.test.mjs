import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listWebhooks } from '../do-work/list-resend-webhooks.mjs';

const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(payload => payload.id === 'tool:list-resend-webhooks');
const canary = 'held-key-canary-0123456789';
const secretCanary = 'whsec_signing-secret-canary';
const answering = (status, body) => async (address, request) => {
  assert.equal(address, 'https://api.resend.com/webhooks');
  assert.equal(request.headers.Authorization, `Bearer ${canary}`);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

test('the row hands the held key on a private pipe, reads only, and runs on the person\'s computer', () => {
  assert.ok(row, 'tools/email-sending-domains/what-this-tool-does-and-how-to-run-it.json has tool:list-resend-webhooks');
  assert.deepEqual(row.invoke.key, [{ secret_name_from_input: 'key_name', fd: 3 }]);
  assert.ok(Array.isArray(row.invoke.may_reach));
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.deepEqual(row.input_schema.required, ['key_name']);
  assert.deepEqual(row.verify[0].replies.map(reply => reply.request), [{ method: 'GET', url: 'https://api.resend.com/webhooks' }]);
});

test('answers each webhook\'s id, address, state and events and the count, never the key, a secret or the raw reply', async () => {
  const answer = await listWebhooks({ key: `${canary}\n`, fetchImpl: answering(200, { object: 'list', has_more: false, data: [
    { id: 'w-1', endpoint: 'https://example.com/webhooks/mail', status: 'enabled', events: ['email.delivered', 'email.bounced'], created_at: '2026-11-01 12:00:00+00', signing_secret: secretCanary },
    { id: 'w-2', endpoint: 'https://example.org/hooks', status: 'disabled', events: ['email.opened'] },
  ] }) });
  assert.deepEqual(answer, { webhooks: [
    { id: 'w-1', url: 'https://example.com/webhooks/mail', status: 'enabled', events: ['email.delivered', 'email.bounced'] },
    { id: 'w-2', url: 'https://example.org/hooks', status: 'disabled', events: ['email.opened'] },
  ], count: 2 });
  const said = JSON.stringify(answer);
  assert.ok(!said.includes(canary) && !said.includes(secretCanary), 'neither the key nor a signing secret is answered');
});

test('an account with no webhooks answers an empty list', async () => {
  assert.deepEqual(await listWebhooks({ key: canary, fetchImpl: answering(200, { object: 'list', data: [] }) }), { webhooks: [], count: 0 });
});

test('a refused or missing key says what to do, without the key', async () => {
  await assert.rejects(listWebhooks({ key: canary, fetchImpl: answering(401, {}) }), error => /Connect the account again/.test(error.message) && !error.message.includes(canary));
  await assert.rejects(listWebhooks({ key: canary, fetchImpl: answering(500, {}) }), /answered 500\. Try again later/);
  await assert.rejects(listWebhooks({ key: '', fetchImpl: answering(200, {}) }), /Connect the email-sending account first/);
});
