// RFC 8291 Web Push encryption and RFC 8292 VAPID authentication.
// Subscription endpoints, browser encryption keys and VAPID private material are inputs only: this module stores none.

const RECORD_SIZE = 4096;
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 86 - 16 - 1;
const encoder = new TextEncoder();
const bytes = value => value instanceof Uint8Array ? value : ArrayBuffer.isView(value)
  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
const join = (...parts) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};

export const base64url = value => {
  const input = bytes(value);
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function fromBase64url(value, label = 'base64url value') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error(`${label} is not valid base64url.`);
  }
  const decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), character => character.charCodeAt(0));
  if (base64url(decoded) !== value) throw new Error(`${label} is not canonical base64url.`);
  return decoded;
}

const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign(
  'HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data,
));
const hkdf = async (salt, input, info, length) => (await hmac(await hmac(salt, input), join(info, Uint8Array.of(1)))).slice(0, length);

export function publicPoint(jwk) {
  if (!jwk || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('A P-256 public key needs x and y coordinates.');
  const x = fromBase64url(jwk.x, 'P-256 x coordinate');
  const y = fromBase64url(jwk.y, 'P-256 y coordinate');
  if (x.length !== 32 || y.length !== 32) throw new Error('P-256 coordinates must each be 32 bytes.');
  return join(Uint8Array.of(4), x, y);
}

export async function makeSigningKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { kty, crv, x, y, d };
}

function checkedVapid(vapid) {
  const jwk = vapid?.jwk;
  if (jwk?.kty !== 'EC' || jwk?.crv !== 'P-256' || typeof jwk.d !== 'string') throw new Error('The VAPID key must be a private P-256 JWK.');
  const point = publicPoint(jwk);
  const contact = vapid?.contact;
  if (typeof contact !== 'string' || !(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(contact))) {
    throw new Error('VAPID contact must be a mailto: address or HTTPS URL.');
  }
  return { jwk, point, contact };
}

/** The browser applicationServerKey derived from the same complete private key used for signing pushes. */
export async function applicationServerKey(vapid) {
  const { jwk, point } = checkedVapid(vapid);
  await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return base64url(point);
}

export async function vapidAuthorization(vapid, audience, nowSeconds = Math.floor(Date.now() / 1000)) {
  const { jwk, point, contact } = checkedVapid(vapid);
  const origin = new URL(audience);
  if (origin.protocol !== 'https:' || origin.origin !== audience) throw new Error('VAPID audience must be an HTTPS origin.');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = value => base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: origin.origin, exp: nowSeconds + 12 * 60 * 60, sub: contact })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${base64url(signature)}, k=${base64url(point)}`;
}

export function checkedSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== 'string') throw new Error('A browser push subscription needs its endpoint.');
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('A browser push endpoint must be an HTTPS URL without credentials or a fragment.');
  }
  const p256dh = fromBase64url(subscription.keys?.p256dh, 'Browser P-256 public key');
  const auth = fromBase64url(subscription.keys?.auth, 'Browser auth secret');
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new Error('Browser P-256 public key must be an uncompressed 65-byte point.');
  if (auth.length !== 16) throw new Error('Browser auth secret must be 16 bytes.');
  return { endpoint, keys: { p256dh, auth } };
}

/** Encrypt one message for the exact browser subscription using aes128gcm. */
export async function encryptFor(subscription, plaintext, { ephemeral = null, salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const checked = checkedSubscription(subscription);
  const message = typeof plaintext === 'string' ? encoder.encode(plaintext) : bytes(plaintext);
  if (message.length > MAX_PLAINTEXT_BYTES) throw new Error(`A push message is at most ${MAX_PLAINTEXT_BYTES} bytes.`);
  if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new Error('Web Push salt must be 16 bytes.');
  const uaPublic = checked.keys.p256dh;
  const authSecret = checked.keys.auth;
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

/** One request only. Fetch rejection is marked unknown and must never be retried without caller reconciliation. */
export async function sendPush(subscription, message, { vapid, ttl_seconds = 86400, urgency = 'normal', send = fetch } = {}) {
  const checked = checkedSubscription(subscription);
  if (!Number.isSafeInteger(ttl_seconds) || ttl_seconds < 0 || ttl_seconds > 2_419_200) throw new Error('ttl_seconds must be an integer from 0 to 2419200.');
  if (!['very-low', 'low', 'normal', 'high'].includes(urgency)) throw new Error('urgency must be very-low, low, normal or high.');
  const payload = encoder.encode(JSON.stringify(message));
  const body = await encryptFor(subscription, payload);
  let response;
  try {
    response = await send(checked.endpoint.href, {
      method: 'POST',
      headers: {
        authorization: await vapidAuthorization(vapid, checked.endpoint.origin),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl_seconds), urgency,
      },
      body,
      redirect: 'error',
    });
  } catch {
    return { sent: false, unknown: true, retryable: false, said: 'The push request ended before a response arrived; its outcome is unknown. Reconcile before another send.' };
  }
  if (response.ok) return { sent: true, accepted: true, status: response.status, said: 'The browser push service accepted the notice.' };
  const gone = response.status === 404 || response.status === 410;
  const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  return {
    sent: false, accepted: false, status: response.status, gone, retryable,
    said: `The push service refused the request with HTTP ${response.status}.`,
  };
}

/** Service-worker half: show a notice and hand its stable action identity to the local app when clicked. */
export const PUSH_SERVICE_WORKER = `self.addEventListener('push', event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { title: event.data ? event.data.text() : '' }; }
  const actions = Array.isArray(message.actions) ? message.actions.filter(action => action && typeof action.id === 'string' && typeof action.label === 'string').slice(0, 2) : [];
  event.waitUntil(self.registration.showNotification(message.title || 'New notice', {
    body: message.body || '', tag: message.tag || undefined, icon: message.icon || undefined,
    actions: actions.map(action => ({ action: action.id, title: action.label })),
    data: { open: message.open || '/', notice_id: message.notice_id || null, actions: actions.map(action => action.id) },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = typeof event.action === 'string' ? event.action : '';
  const candidate = new URL((data.open) || '/', self.location.origin);
  const address = (candidate.origin === self.location.origin ? candidate : new URL('/', self.location.origin)).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let same = open.find(client => client.url === address) || open.find(client => new URL(client.url).origin === self.location.origin);
    if (!same) same = await self.clients.openWindow(address);
    if (!same) return;
    if (action && data.notice_id && Array.isArray(data.actions) && data.actions.includes(action)) {
      same.postMessage({ type: 'notice-action', notice_id: data.notice_id, action });
      return same.focus();
    }
    if (same.url !== address && 'navigate' in same) await same.navigate(address);
    return same.focus();
  })());
});
`;
