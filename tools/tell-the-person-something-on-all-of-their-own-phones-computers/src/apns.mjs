// src/apns.mjs
//
// Purpose
//   Sends one push to one Apple device through Apple's push service (APNs), with token authentication: a short-lived
//   ES256 provider token signed by the team's push key, Web Crypto only, so it runs in the Worker as it is.
//
// Non-negotiable invariants
//   1. The push key is read by its caller from where it is held (a Worker secret named by DATA) and passed in; nothing
//      here reads a secret, logs it, or returns it.
//   2. A device token is sent to the server of the environment it was registered in (sandbox for a development build,
//      production for TestFlight and the App Store); a token sent to the wrong one would be refused as bad.
//   3. Apple saying a token is no longer valid (410, or 400 BadDeviceToken/DeviceTokenNotForTopic) is reported as
//      `gone`, so the caller removes the device instead of trying it again.
//   4. One provider token is reused until it is `token_minutes` old (Apple refuses a fresh one more often than every 20
//      minutes and an old one after an hour).
//
// Key concepts
//   key      { key_id, team_id, pem (PKCS#8 PEM, the .p8 file's text) }
//   push     { token, topic, environment: sandbox | production, push_type: alert | liveactivity | background,
//              priority, payload, collapse_id?, expiration? }
//
// Security
//   ES256 (ECDSA P-256) is Apple's required JWT algorithm for APNs: an external protocol signature, never an identity
//   this code mints.
//

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };

const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const text64 = value => base64url(new TextEncoder().encode(JSON.stringify(value)));

async function signingKey(pem) {
  // The .p8 text as kept: its header lines and any line breaks, real or written as \n inside a JSON string, are not key.
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  const der = Uint8Array.from(atob(body), char => char.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The provider token for `key`, made at `nowSeconds`. */
export async function providerToken(key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const unsigned = `${text64({ alg: 'ES256', kid: key.key_id })}.${text64({ iss: key.team_id, iat: nowSeconds })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(key.pem), new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(signature)}`;
}

/**
 * One sender for one key: `send(push)` → { sent, status, gone?, error? }. Provider tokens are kept for
 * `token_minutes` between sends.
 */
export function apnsSender(key, { send = fetch, token_minutes = 40, now = () => Date.now() } = {}) {
  let held = null;
  const token = async () => {
    if (!held || now() - held.at > token_minutes * 60_000) held = { at: now(), value: await providerToken(key, Math.floor(now() / 1000)) };
    return held.value;
  };
  return async function push({ token: device, topic, environment = 'production', push_type = 'alert', priority = 10, payload, collapse_id = null, expiration = null }) {
    const host = HOSTS[environment] ?? HOSTS.production;
    const response = await send(`${host}/3/device/${device}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${await token()}`,
        'apns-topic': topic,
        'apns-push-type': push_type,
        'apns-priority': String(priority),
        ...(collapse_id ? { 'apns-collapse-id': String(collapse_id).slice(0, 64) } : {}),
        ...(expiration !== null ? { 'apns-expiration': String(expiration) } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (response.ok) return { sent: true, status: response.status };
    const reason = await response.json().then(answer => answer.reason).catch(() => null);
    const gone = response.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason);
    return { sent: false, status: response.status, gone, error: reason ? `Apple answered ${reason}.` : `Apple answered ${response.status}.` };
  };
}
