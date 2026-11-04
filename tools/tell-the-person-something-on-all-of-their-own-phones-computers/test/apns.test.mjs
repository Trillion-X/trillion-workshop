// Apple pushes: the provider token is an ES256 JWT that verifies with the push key it names, a push goes to the server
// of the device's environment with the notice's topic and type, the token is reused between sends, and Apple saying a
// device token is no longer valid comes back as gone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apnsSender, providerToken } from '../src/apns.mjs';

async function teamKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return { key: { key_id: 'ABC123DEFG', team_id: 'TEAM123456', pem }, publicKey: pair.publicKey };
}
const part = text => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));

test('the provider token names the key and team and verifies with the key', async () => {
  const { key, publicKey } = await teamKey();
  const token = await providerToken(key, 1_790_000_000);
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(part(head), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.deepEqual(part(claims), { iss: 'TEAM123456', iat: 1_790_000_000 });
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${head}.${claims}`));
  assert.equal(ok, true);
});

test('a push goes to its environment\'s server with its topic and type, reusing one provider token', async () => {
  const { key } = await teamKey();
  const asked = [];
  const push = apnsSender(key, { send: async (url, init) => { asked.push({ url, init }); return new Response(null, { status: 200 }); } });
  assert.deepEqual(await push({ token: 'ab'.repeat(32), topic: 'ai.gettrillion.ios', environment: 'sandbox', payload: { aps: { alert: { title: 'Hi' } } } }), { sent: true, status: 200 });
  await push({ token: 'cd'.repeat(32), topic: 'ai.gettrillion.ios.push-type.liveactivity', push_type: 'liveactivity', priority: 5, payload: { aps: {} } });
  assert.equal(asked[0].url, `https://api.sandbox.push.apple.com/3/device/${'ab'.repeat(32)}`);
  assert.equal(asked[1].url, `https://api.push.apple.com/3/device/${'cd'.repeat(32)}`);
  assert.equal(asked[0].init.headers['apns-push-type'], 'alert');
  assert.equal(asked[1].init.headers['apns-push-type'], 'liveactivity');
  assert.equal(asked[1].init.headers['apns-priority'], '5');
  assert.equal(asked[0].init.headers.authorization, asked[1].init.headers.authorization, 'one provider token is reused');
  assert.deepEqual(JSON.parse(asked[0].init.body), { aps: { alert: { title: 'Hi' } } });
});

test('Apple refusing a token says the device is gone; any other refusal is not', async () => {
  const { key } = await teamKey();
  const answer = (status, reason) => apnsSender(key, { send: async () => Response.json({ reason }, { status }) });
  assert.equal((await answer(410, 'Unregistered')({ token: 'ab'.repeat(32), topic: 't', payload: {} })).gone, true);
  assert.equal((await answer(400, 'BadDeviceToken')({ token: 'ab'.repeat(32), topic: 't', payload: {} })).gone, true);
  const busy = await answer(429, 'TooManyRequests')({ token: 'ab'.repeat(32), topic: 't', payload: {} });
  assert.equal(busy.gone, false);
  assert.equal(busy.error, 'Apple answered TooManyRequests.');
});
