import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLAINTEXT_BYTES, base64url, encryptFor, fromBase64url, makeSigningKey,
  publicPoint, sendPush, vapidAuthorization, PUSH_SERVICE_WORKER,
} from '../read-data/web-push.mjs';

const encoder = new TextEncoder();
const join = (...parts) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign(
  'HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data,
));
const hkdf = async (salt, input, info, length) => (await hmac(await hmac(salt, input), join(info, Uint8Array.of(1)))).slice(0, length);

async function fixture() {
  const browser = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicJwk = await crypto.subtle.exportKey('jwk', browser.publicKey);
  const secret = crypto.getRandomValues(new Uint8Array(16));
  return {
    browser,
    subscription: {
      endpoint: 'https://push.example.test/send/subscription',
      keys: { p256dh: base64url(publicPoint(publicJwk)), auth: base64url(secret) },
    },
    vapid: { jwk: await makeSigningKey(), contact: 'mailto:push@example.test' },
  };
}

test('aes128gcm body can be decrypted by the subscribing browser with its private key', async () => {
  const { browser, subscription } = await fixture();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptFor(subscription, 'hello from the app', { salt });
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  const keyLength = body[20];
  assert.equal(keyLength, 65);
  const senderPoint = body.slice(21, 21 + keyLength);
  const ciphertext = body.slice(21 + keyLength);
  const sender = await crypto.subtle.importKey('raw', senderPoint, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, browser.privateKey, 256));
  const auth = fromBase64url(subscription.keys.auth);
  const uaPublic = fromBase64url(subscription.keys.p256dh);
  const ikm = await hkdf(auth, shared, join(encoder.encode('WebPush: info\0'), uaPublic, senderPoint), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  assert.equal(new TextDecoder().decode(clear.slice(0, -1)), 'hello from the app');
  assert.equal(clear.at(-1), 2);
});

test('VAPID signs the endpoint origin and send uses encrypted body with safe push headers', async () => {
  const { subscription, vapid } = await fixture();
  const auth = await vapidAuthorization(vapid, new URL(subscription.endpoint).origin, 1_800_000_000);
  assert.match(auth, /^vapid t=[A-Za-z0-9_.-]+, k=[A-Za-z0-9_-]+$/);
  let captured;
  const result = await sendPush(subscription, { title: 'New notice', body: 'Open the app', open: '/notices/1' }, {
    vapid, ttl_seconds: 60, urgency: 'high', send: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 201 };
    },
  });
  assert.deepEqual(result, { sent: true, accepted: true, status: 201, said: 'The browser push service accepted the notice.' });
  assert.equal(captured.url, subscription.endpoint);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.headers['content-encoding'], 'aes128gcm');
  assert.equal(captured.options.headers['content-type'], 'application/octet-stream');
  assert.equal(captured.options.headers.ttl, '60');
  assert.equal(captured.options.headers.urgency, 'high');
  assert.ok(captured.options.body instanceof Uint8Array);
  assert.ok(captured.options.body.length > 100);
});

test('known gone and retryable provider failures are classified, while a lost response remains unknown', async () => {
  const { subscription, vapid } = await fixture();
  const gone = await sendPush(subscription, { id: 'notice' }, { vapid, send: async () => ({ ok: false, status: 410, text: async () => 'expired' }) });
  assert.deepEqual(gone, { sent: false, accepted: false, status: 410, gone: true, retryable: false, said: 'The push service refused the request with HTTP 410.' });
  const retry = await sendPush(subscription, { id: 'notice' }, { vapid, send: async () => ({ ok: false, status: 503, text: async () => '' }) });
  assert.equal(retry.retryable, true);
  assert.equal(retry.unknown, undefined);
  const unknown = await sendPush(subscription, { id: 'notice' }, { vapid, send: async () => { throw new Error(`network reset for ${subscription.endpoint}`); } });
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.retryable, false);
  assert.doesNotMatch(unknown.said, /push\.example|subscription/i);
});

test('invalid endpoint, keys, VAPID data, message sizes and TTL fail before sending', async () => {
  const { subscription, vapid } = await fixture();
  const call = async (candidate, message = { id: 'notice' }, options = { vapid, send: async () => { throw new Error('must not send'); } }) => sendPush(candidate, message, options);
  await assert.rejects(call({ ...subscription, endpoint: 'http://push.example.test/x' }), /HTTPS/);
  await assert.rejects(call({ ...subscription, endpoint: 'https://user:secret@push.example.test/x' }), /credentials/);
  await assert.rejects(call({ ...subscription, keys: { ...subscription.keys, auth: 'ab=' } }), /base64url/);
  await assert.rejects(call(subscription, 'x'.repeat(MAX_PLAINTEXT_BYTES)), /at most/);
  await assert.rejects(call(subscription, { id: 'n' }, { vapid, ttl_seconds: -1 }), /ttl_seconds/);
  await assert.rejects(vapidAuthorization(vapid, 'http://push.example.test'), /HTTPS origin/);
});

test('browser notifications expose offered buttons and forward only their stable notice/action ids to the app', () => {
  assert.match(PUSH_SERVICE_WORKER, /actions: actions\.map\(action => \(\{ action: action\.id, title: action\.label \}\)\)/);
  assert.match(PUSH_SERVICE_WORKER, /notice_id: message\.notice_id/);
  assert.match(PUSH_SERVICE_WORKER, /type: 'notice-action', notice_id: data\.notice_id, action/);
});
