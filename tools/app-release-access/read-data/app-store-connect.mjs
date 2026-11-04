// tools/app-release-access/read-data/app-store-connect.mjs (moved from old trillion scripts/app-store-connect.mjs)
//
// Purpose: the App Store Connect API client the release-access tools use. It signs a short-lived JWT from the
// release owner's team API key and makes JSON requests to api.appstoreconnect.apple.com only.
//
// Invariants:
// - The key is the release owner's held value `app-store-connect-key`, handed to this one process on a private pipe
//   (the row's invoke.credential_mounts, descriptor 4) as JSON { key_id, issuer_id, private_key }. It stays in this
//   process's memory: never a file, argv, environment, log, error message or answer. Nothing reads a Keychain.
// - ES256 (ECDSA P-256 over SHA-256) is App Store Connect's required JWT algorithm; it is an external protocol
//   signature, never an identity this code mints.
// - Every request names the statuses it accepts; anything else throws with its status (error.status). Apple's error
//   body can name a tester's address, so it is never put in the error.
import { createPrivateKey, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = 'https://api.appstoreconnect.apple.com';
export const KEY_DESCRIPTOR = 4;

/** The held team key { keyId, issuerId, keyText }, from the JSON text the pipe carried. */
export function heldKey(text) {
  let value;
  try { value = JSON.parse(String(text ?? '')); } catch { value = null; }
  const keyId = value?.key_id, issuerId = value?.issuer_id, keyText = value?.private_key;
  if (typeof keyId !== 'string' || !keyId || typeof issuerId !== 'string' || !issuerId || typeof keyText !== 'string') {
    throw new Error('No App Store Connect team key was handed to this run. Hold one as app-store-connect-key ({key_id, issuer_id, private_key}).');
  }
  if (!keyText.includes('BEGIN PRIVATE KEY')) throw new Error('The held App Store Connect key is not a .p8 private key.');
  return { keyId, issuerId, keyText };
}

/** Read the held key from its descriptor; a run handed none answers heldKey's plain refusal. */
export function readHeldKey(descriptor = KEY_DESCRIPTOR) {
  let text = '';
  try { text = readFileSync(descriptor, 'utf8'); } catch { text = ''; }
  return heldKey(text);
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Make a client bound to one team key. `apiKey` is heldKey's answer; its issuer is `issuerId`. */
export function appStoreConnect({ apiKey, issuerId = apiKey?.issuerId, fetcher = fetch, timeoutMs = 15_000 }) {
  const { keyId, keyText } = apiKey ?? {};
  if (!keyId || !issuerId || typeof keyText !== 'string') throw new Error('App Store Connect needs a named team API credential.');
  const signingKey = createPrivateKey(keyText);
  if (signingKey.asymmetricKeyType !== 'ec' || signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('App Store Connect needs an ES256 team API credential.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error('The Apple request deadline must be between 1 and 60000 milliseconds.');
  let token = null;
  let tokenExpires = 0;

  function jwt() {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < tokenExpires - 60) return token;
    tokenExpires = now + 19 * 60;
    const header = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({ iss: issuerId, iat: now, exp: tokenExpires, aud: 'appstoreconnect-v1' }));
    const signer = createSign('SHA256');
    signer.update(`${header}.${payload}`);
    token = `${header}.${payload}.${base64Url(signer.sign({ key: signingKey, dsaEncoding: 'ieee-p1363' }))}`;
    return token;
  }

  async function request(method, path, { query = {}, body, accepted = [200] } = {}) {
    const url = new URL(path, API);
    if (url.origin !== API || !url.pathname.startsWith('/v1/')) throw new Error('The Apple API request must stay on App Store Connect.');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const headers = { Authorization: `Bearer ${jwt()}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (!accepted.includes(response.status)) {
      const error = new Error(`${method} ${path} answered ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return text.trim() ? JSON.parse(text) : null;
  }

  return {
    keyId,
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, accepted = [201]) => request('POST', path, { body, accepted }),
  };
}
