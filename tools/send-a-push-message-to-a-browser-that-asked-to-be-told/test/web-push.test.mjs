// A pushed message is encrypted exactly as RFC 8291 says (its Appendix A example, byte for byte), a browser holding the
// subscription's key reads it back, the VAPID header verifies with the service's public key, and a push service that
// has forgotten a subscription (410) is reported as gone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { base64url, encryptFor, fromBase64url, makeSigningKey, publicPoint, sendPush, vapidAuthorization } from '../../shared-code/src/web-push.mjs';

const point = text => { const raw = fromBase64url(text); return { x: base64url(raw.slice(1, 33)), y: base64url(raw.slice(33, 65)) }; };
// RFC 8291 Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  as: { d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', ...point('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8') },
  ua: { d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4' },
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// The browser's side: what a user agent does with an aes128gcm body.
async function decryptAsBrowser(body, { uaJwk, uaPublic, auth }) {
  const salt = body.slice(0, 16);
  const keyLength = body[20];
  const asPublic = body.slice(21, 21 + keyLength);
  const sealed = body.slice(21 + keyLength);
  const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
  const hkdf = async (s, ikm, info, length) => (await hmac(await hmac(s, ikm), new Uint8Array([...info, 1]))).slice(0, length);
  const own = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', ...uaJwk }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const theirs = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, own, 256));
  const text = value => new TextEncoder().encode(value);
  const ikm = await hkdf(auth, shared, new Uint8Array([...text('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
  const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), sealed));
  assert.equal(plain.at(-1), 2, 'the last record ends with the 0x02 delimiter');
  return new TextDecoder().decode(plain.slice(0, -1));
}

test('the RFC 8291 example encrypts to the same bytes', async () => {
  const body = await encryptFor({ keys: { p256dh: RFC.ua.public, auth: RFC.auth } }, RFC.plaintext, { ephemeral: { jwk: RFC.as }, salt: fromBase64url(RFC.salt) });
  assert.equal(base64url(body), RFC.body);
});

test('a browser holding the subscription reads a fresh message back', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const uaPublic = publicPoint(uaJwk);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const message = JSON.stringify({ title: 'A new video is in your files', body: 'clip.mp4', open: '/files' });
  const body = await encryptFor({ keys: { p256dh: base64url(uaPublic), auth: base64url(auth) } }, message);
  assert.equal(await decryptAsBrowser(body, { uaJwk, uaPublic, auth }), message);
});

test('the VAPID header is a JWT signed by the key it names', async () => {
  const jwk = await makeSigningKey();
  const header = await vapidAuthorization({ jwk, contact: 'mailto:hello@gettrillion.ai' }, 'https://fcm.googleapis.com', 1_800_000_000);
  const [, token, key] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(key, base64url(publicPoint(jwk)));
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromBase64url(claims))), { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43_200, sub: 'mailto:hello@gettrillion.ai' });
  const verifier = await crypto.subtle.importKey('raw', fromBase64url(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, fromBase64url(signature), new TextEncoder().encode(`${head}.${claims}`)), true);
});

test('a push service that forgot the subscription is reported as gone', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: base64url(publicPoint(await crypto.subtle.exportKey('jwk', pair.privateKey))), auth: base64url(new Uint8Array(16)) } };
  const vapid = { jwk: await makeSigningKey(), contact: 'mailto:hello@gettrillion.ai' };
  const seen = [];
  const gone = await sendPush(subscription, { title: 'x' }, { vapid, send: async (url, init) => { seen.push({ url, init }); return new Response('', { status: 410 }); } });
  assert.deepEqual({ sent: gone.sent, gone: gone.gone }, { sent: false, gone: true });
  assert.equal(seen[0].init.headers['content-encoding'], 'aes128gcm');
  assert.match(seen[0].init.headers.authorization, /^vapid t=/);
  const sent = await sendPush(subscription, { title: 'x' }, { vapid, send: async () => new Response('', { status: 201 }) });
  assert.deepEqual(sent, { sent: true, status: 201 });
});
