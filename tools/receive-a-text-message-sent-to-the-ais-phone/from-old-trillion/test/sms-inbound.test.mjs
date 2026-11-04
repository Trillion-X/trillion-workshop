import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInboundSms, twilioSignature } from '../src/sms-inbound.mjs';
import { startFromEntry } from '../../../start-from-any-landing-page/src/entry-points.mjs';

const origin = 'https://app.example.test';
const env = { SMS_TWILIO_FROM: '+14155550100', PHONE_INDEX_KEY: 'ab'.repeat(32), SMS_TWILIO_AUTH_TOKEN: 'cd'.repeat(32) };
const store = () => {
  const kept = new Map();
  return { kept, read: async key => kept.get(key) ?? null, keep: async (key, value) => { kept.set(key, value); } };
};
const signedRequest = async (fields, token = env.SMS_TWILIO_AUTH_TOKEN, url = `${origin}/sms/inbound`) => {
  const body = new URLSearchParams(fields);
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': await twilioSignature(url, body, token) }, body: body.toString() });
};
const run = (request, kv, extra = {}) => handleInboundSms(request, env, { origin, read: kv.read, keep: kv.keep, ownerOf: async () => null, deliver: async () => { throw new Error('should not deliver'); }, ...extra });

test('Twilio signature matches the documented scheme', async () => {
  // Twilio's published example: https://www.twilio.com/docs/usage/security
  const params = new URLSearchParams({ CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' });
  assert.equal(await twilioSignature('https://mycompany.com/myapp.php?foo=1&bar=2', params, '12345'), 'RSOYDt4T1cUTdK1PDd93/VVr8B8=');
});

test('a signed text from a landing-page lead is answered with the entry welcome; the same message id once', async () => {
  const kv = store();
  await startFromEntry(env, 'default', { phone: '+1 415 555 0123' }, kv.keep);
  const fields = { MessageSid: 'SM1234567890abcdef', From: '+14155550123', To: '+14155550100', Body: 'Hi, I just signed up for Trillion' };
  const answer = await run(await signedRequest(fields), kv);
  assert.equal(answer.status, 200);
  const xml = await answer.text();
  assert.match(xml, /<Message>Trillion here\./);
  assert.match(xml, /https:\/\/app\.example\.test\/account\?from=default/);
  assert.equal(await (await run(await signedRequest(fields), kv)).text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 'a retry of the same message id answers nothing');
});

test('a text from a known account is delivered to that person\'s AIs, once', async () => {
  const kv = store();
  const delivered = [];
  const fields = { MessageSid: 'SMaaaaaaaaaaaaaaa1', From: '+14155550199', Body: 'Remind me about the invoice' };
  const extra = { ownerOf: async phone => (phone === '+14155550199' ? 'user-7' : null), deliver: async (userId, message) => { delivered.push([userId, message]); } };
  await run(await signedRequest(fields), kv, extra);
  await run(await signedRequest(fields), kv, extra);
  assert.deepEqual(delivered, [['user-7', { text: 'Remind me about the invoice', client_id: 'sms:SMaaaaaaaaaaaaaaa1' }]]);
});

test('an unsigned, wrongly signed or stranger request is refused or ignored; no token set is a named 503', async () => {
  const kv = store();
  const fields = { MessageSid: 'SMbbbbbbbbbbbbbbb2', From: '+14155550123', Body: 'hello' };
  assert.equal((await run(await signedRequest(fields, 'ef'.repeat(32)), kv)).status, 403);
  assert.equal((await run(new Request(`${origin}/sms/inbound`, { method: 'POST', body: new URLSearchParams(fields).toString() }), kv)).status, 403);
  assert.equal(kv.kept.size, 0, 'nothing is recorded for a refused request');
  const stranger = await run(await signedRequest({ ...fields, MessageSid: 'SMccccccccccccccc3', From: '+14155550777' }), kv);
  assert.equal(await stranger.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const noToken = await handleInboundSms(await signedRequest(fields), { ...env, SMS_TWILIO_AUTH_TOKEN: undefined }, { origin, read: kv.read, keep: kv.keep, ownerOf: async () => null, deliver: async () => {} });
  assert.equal(noToken.status, 503);
  assert.match((await noToken.json()).error, /SMS_TWILIO_AUTH_TOKEN/);
  assert.equal(kv.kept.size, 1, 'only the signed stranger message id is remembered, never the number');
});
