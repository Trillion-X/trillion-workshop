function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Make a client bound to one team key. `issuerId` comes from DATA; the key comes from the Keychain. */
export function appStoreConnect({ keychainService, issuerId, apiKey, fetcher = fetch, timeoutMs = 15_000 }) {
  const { keyId, keyText } = apiKey ?? keyFromKeychain(keychainService);
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
      const error = new Error(`${method} ${path} answered ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    return text.trim() ? JSON.parse(text) : null;
  }
