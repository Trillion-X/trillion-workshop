// tools/send-messages/test/send-in-process.test.mjs
//
// Sending inside the caller's own process (inProcess): a site program bundled into one file cannot start an adapter
// script as a process, so it imports the adapters it may use and hands them in. The provider is still the row's choice,
// the keys go only to that one send (never into process.env), an adapter not handed in is refused by name, and an
// adapter that fails says why, as it does when it runs as a process. No network: fetch is a stand-in for each test.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, it } from 'node:test';
import { inProcess, sendMessage } from '../do-work/send-a-message.mjs';

const require = createRequire(import.meta.url);
const resend = require('../do-work/send-via-resend.cjs');
const twilio = require('../do-work/send-via-twilio-sms.cjs');
const ses = require('../do-work/send-via-amazon-ses.cjs');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const recording = (reply = { status: 200, body: '{"id":"msg-1"}' }) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), headers: init.headers, body: String(init.body ?? '') }); return new Response(reply.body, { status: reply.status }); };
  return calls;
};
const email = { recipients: ['reader@example.com'], from: 'Coach <coach@example.com>', subject: 'Lesson one', html: '<p>Hi</p>', text: 'Hi',
  headers: { 'List-Unsubscribe': '<https://example.com/stop/t>' }, idempotencyKey: 'lesson-1' };

it('every adapter can be imported and sends through send(input, env)', () => {
  for (const adapter of [resend, twilio, ses]) assert.equal(typeof adapter.send, 'function');
  assert.equal(typeof ses.signV4, 'function', 'what the SES adapter exported before is still there');
});

it('an email goes out in this process through the row\'s provider, with the key only in that send', async () => {
  const calls = recording();
  const answer = await sendMessage(email, { providerId: 'resend', credentials: { RESEND_API_KEY: 'test-key' }, run: inProcess({ 'send-via-resend.cjs': resend }) });
  assert.deepEqual(answer.sent, [{ recipient: 'reader@example.com', messageId: 'msg-1' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].headers.authorization, 'Bearer test-key');
  assert.equal(calls[0].headers['idempotency-key'], 'lesson-1');
  assert.deepEqual(JSON.parse(calls[0].body), { from: 'Coach <coach@example.com>', to: ['reader@example.com'], subject: 'Lesson one', html: '<p>Hi</p>', text: 'Hi', headers: email.headers });
  assert.equal(process.env.RESEND_API_KEY, undefined, 'the key never lands in this process\'s environment');
  assert.equal(process.env.EMAIL_FROM, undefined);
});

it('a text goes out in this process the same way', async () => {
  const calls = recording({ status: 201, body: '{"sid":"SM0123456789abcdef0123456789abcdef"}' });
  const answer = await sendMessage({ to: '+15550100', text: 'Hello', from: '+15550199', account_sid: 'AC1' },
    { providerId: 'twilio-sms', credentials: { TWILIO_AUTH_TOKEN: 'tok' }, run: inProcess({ 'send-via-twilio-sms.cjs': twilio }) });
  assert.deepEqual(answer.sent, [{ recipient: '+15550100', messageId: 'SM0123456789abcdef0123456789abcdef' }]);
  assert.match(calls[0].url, /\/Accounts\/AC1\/Messages\.json$/);
});

it('a provider whose adapter was not handed in is refused by name, and nothing is sent', async () => {
  const calls = recording();
  await assert.rejects(sendMessage(email, { providerId: 'resend', credentials: { RESEND_API_KEY: 'k' }, run: inProcess({ 'send-via-twilio-sms.cjs': twilio }) }),
    /needs its adapter send-via-resend\.cjs/);
  assert.equal(calls.length, 0);
});

it('a provider refusal is that recipient\'s error, and an adapter that cannot start says why', async () => {
  recording({ status: 422, body: '{"name":"validation_error","message":"Invalid from"}' });
  const answer = await sendMessage(email, { providerId: 'resend', credentials: { RESEND_API_KEY: 'k' }, run: inProcess({ 'send-via-resend.cjs': resend }) });
  assert.match(answer.sent[0].error, /Resend 422 validation_error: Invalid from/);
  const broken = { send: async () => { throw new Error('Missing required Resend credentials: RESEND_API_KEY, EMAIL_FROM'); } };
  await assert.rejects(sendMessage(email, { providerId: 'resend', credentials: { RESEND_API_KEY: 'k' }, run: inProcess({ 'send-via-resend.cjs': broken }) }),
    /Resend did not answer: Missing required Resend credentials/);
});
