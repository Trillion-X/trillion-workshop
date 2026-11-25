import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSentEmail } from '../do-work/read-a-sent-email.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(payload => payload.id === 'tool:read-a-sent-email');
const canary = 'held-key-canary-0123456789';
const bodyCanary = 'email-body-canary';
const id = '00000000-0000-4000-8000-000000000031';
const answering = (status, body) => async (address, request) => {
  assert.equal(address, `https://api.resend.com/emails/${id}`);
  assert.equal(request.headers.Authorization, `Bearer ${canary}`);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

test('the row hands the held key on a private pipe, the input on stdin, reads only, and runs on the person\'s computer', () => {
  assert.ok(row, 'tools/email-sending-domains/tool-rows.json has tool:read-a-sent-email');
  assert.deepEqual(row.invoke.credential_mounts, [{ secret_name_from_input: 'key_name', fd: 3 }]);
  assert.deepEqual(row.invoke.stdin, { fill: { from: 'input' } });
  assert.equal(row.invoke.internet, true);
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.deepEqual(row.input_schema.required, ['key_name', 'email_id']);
  assert.deepEqual(row.verify[0].replies.map(reply => reply.request), [{ method: 'GET', url: `https://api.resend.com/emails/${id}` }]);
});

test('answers the email\'s id, sender, addressees, subject, time and last event, never the key or the body', async () => {
  const answer = await readSentEmail({ key: `${canary}\n`, email_id: id, fetchImpl: answering(200, {
    object: 'email', id, from: 'Sender <sender@example.com>', to: ['delivered@example.org'], subject: 'Hello',
    created_at: '2026-11-25 14:45:46.162+00', last_event: 'delivered', html: `<p>${bodyCanary}</p>`, text: bodyCanary,
  }) });
  assert.deepEqual(answer, { id, from: 'Sender <sender@example.com>', to: ['delivered@example.org'], subject: 'Hello', created_at: '2026-11-25 14:45:46.162+00', last_event: 'delivered' });
  const said = JSON.stringify(answer);
  assert.ok(!said.includes(canary) && !said.includes(bodyCanary), 'neither the key nor the body is answered');
});

test('an id that is not letters, digits and dashes is refused before anything is asked', async () => {
  await assert.rejects(readSentEmail({ key: canary, email_id: '../api-keys', fetchImpl: () => assert.fail('nothing is asked') }), /letters, digits and dashes only/);
});

test('a refused or missing key, or an unknown email, says what to do, without the key', async () => {
  await assert.rejects(readSentEmail({ key: canary, email_id: id, fetchImpl: answering(401, {}) }), error => /Connect the account again/.test(error.message) && !error.message.includes(canary));
  await assert.rejects(readSentEmail({ key: canary, email_id: id, fetchImpl: answering(404, {}) }), /has no email/);
  await assert.rejects(readSentEmail({ key: canary, email_id: id, fetchImpl: answering(500, {}) }), /answered 500\. Try again later/);
  await assert.rejects(readSentEmail({ key: '', email_id: id, fetchImpl: answering(200, {}) }), /Connect the email-sending account first/);
});
