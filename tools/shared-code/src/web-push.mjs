// src/web-push.mjs
//
// Purpose
//   Sends one message to one browser that asked to be told things (a push subscription), the way every browser's push
//   service takes it: the message encrypted for that browser alone (RFC 8291, aes128gcm) and the request signed with
//   the service's own key (VAPID, RFC 8292). Also the page-side half: the service worker lines that show a message
//   when it arrives and open its address when it is clicked.
//
// Non-negotiable invariants
//   1. Only Web Crypto and fetch: the same code runs in the Worker, a browser and Node's tests.
//   2. The signing key is handed in as a JWK (P-256, with x, y and d); where it is kept is the caller's (a Worker secret
//      named by DATA). It is never written anywhere by this module.
//   3. A message is at most MAX_PLAINTEXT_BYTES before encryption, so the encrypted body fits one 4096-byte record.
//   4. A push service that answers 404 or 410 has forgotten the subscription: the reply says `gone: true`, so the
//      caller removes it. Nothing here keeps state.
//
// Key concepts
//   subscription  what the browser's PushManager gives: { endpoint, keys: { p256dh, auth } } (base64url).
//   vapid         { jwk, contact }: the service's signing key and a mailto: or https: address the push service can reach.
//
// Security
//   The message is readable only by the browser holding the subscription's private key; the push service sees ciphertext.
//

const RECORD_SIZE = 4096;
// One record: the 86-byte header (salt, record size, key length, the 65-byte key), the 16-byte AES-GCM tag and the
// one delimiter byte leave the rest for the message.
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 86 - 16 - 1;
const encoder = new TextEncoder();

export const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromBase64url = text => Uint8Array.from(atob(String(text).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(text).length / 4) * 4, '=')), char => char.charCodeAt(0));
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
// HKDF with one expand block (every length here is at most 32 bytes).
const hkdf = async (salt, ikm, info, length) => (await hmac(await hmac(salt, ikm), join(info, Uint8Array.of(1)))).slice(0, length);

/** The uncompressed public point (65 bytes) of a P-256 JWK. */
export const publicPoint = jwk => join(Uint8Array.of(4), fromBase64url(jwk.x), fromBase64url(jwk.y));

/** A new signing key for a service, as the JWK a Worker secret holds. */
export async function makeSigningKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { kty, crv, x, y, d };
}

/** The Authorization header value for one push service origin. */
export async function vapidAuthorization({ jwk, contact }, audience, nowSeconds = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = value => base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: nowSeconds + 12 * 3600, sub: contact })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${base64url(signature)}, k=${base64url(publicPoint(jwk))}`;
}

/**
 * The aes128gcm body for one browser. `ephemeral` ({ jwk } of a P-256 ECDH key) and `salt` are made fresh unless a test
 * hands them in.
 */
export async function encryptFor(subscription, plaintext, { ephemeral = null, salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const message = typeof plaintext === 'string' ? encoder.encode(plaintext) : plaintext;
  if (message.length > MAX_PLAINTEXT_BYTES) throw new Error(`A push message is at most ${MAX_PLAINTEXT_BYTES} bytes.`);
  const uaPublic = fromBase64url(subscription.keys.p256dh);
  const authSecret = fromBase64url(subscription.keys.auth);
  const own = ephemeral
    ? { privateKey: await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', ...ephemeral.jwk }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']), publicPoint: publicPoint(ephemeral.jwk) }
    : await (async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      return { privateKey: pair.privateKey, publicPoint: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
    })();
  const theirs = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, own.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, join(encoder.encode('WebPush: info\0'), uaPublic, own.publicPoint), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, join(message, Uint8Array.of(2))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = own.publicPoint.length;
  return join(header, own.publicPoint, sealed);
}

/**
 * Sends one message. → { sent: true, status } | { sent: false, status, gone, error }. `ttl_seconds` is how long the push
 * service keeps it for a browser that is asleep.
 */
export async function sendPush(subscription, message, { vapid, ttl_seconds = 86400, urgency = 'normal', send = fetch } = {}) {
  const body = await encryptFor(subscription, JSON.stringify(message));
  const response = await send(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuthorization(vapid, new URL(subscription.endpoint).origin),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl_seconds),
      urgency,
    },
    body,
  });
  if (response.ok) return { sent: true, status: response.status };
  const said = (await response.text().catch(() => '')).slice(0, 200);
  return { sent: false, status: response.status, gone: response.status === 404 || response.status === 410, error: said || `The push service answered ${response.status}.` };
}

/**
 * The service worker lines that show a pushed message ({ title, body, open, tag, icon }) and open its address when
 * clicked, focusing a Trillion tab already open there.
 */
export const PUSH_SERVICE_WORKER = `self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { title: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(message.title || 'Trillion', {
    body: message.body || '', tag: message.tag || undefined, icon: message.icon || undefined,
    data: { open: message.open || '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const address = new URL((event.notification.data && event.notification.data.open) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = open.find(client => client.url === address) || open.find(client => new URL(client.url).origin === self.location.origin);
    if (same) { if (same.url !== address && 'navigate' in same) await same.navigate(address); return same.focus(); }
    return self.clients.openWindow(address);
  })());
});
`;
