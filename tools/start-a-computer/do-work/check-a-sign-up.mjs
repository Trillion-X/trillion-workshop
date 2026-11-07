// tools/start-a-computer/do-work/check-a-sign-up.mjs
//
// `tool:check-a-sign-up` (tool-rows.json): prove that a public origin takes a new account end to end, the way a
// browser does it. It signs up one synthetic account with a software passkey made for this run only, signs in with
// that passkey under the new account's address, and reads a page only a signed-in person sees. The answer is each
// step's HTTP status, the new account's address and whether the signed-in read answered 200, never the key, a
// challenge or a session.
//
// The steps follow the sign-up page's own script: GET /sign-up, POST /sign-up/options, POST /sign-up/finish (the
// address), then POST /a/<address>/passkey/options and /passkey/finish (the session), then GET
// /a/<address>/sign-in/security with that session and once without it. Every POST carries the origin as `Origin`,
// as a browser does. The passkey is an ES256 key held in memory; it leaves with the process, so the synthetic account
// can never be signed in to again.
//
// usage: check-a-sign-up.mjs ORIGIN   (ORIGIN is https://host, no path)
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const b64url = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = bytes => createHash('sha256').update(bytes).digest();

/** A software passkey: an ES256 key, its credential id, its SPKI and COSE forms, and a signature counter. */
export function softwarePasskey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  return { id: randomBytes(16), spki, cose, privateKey, counter: 0 };
}

const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

/** The registration response a browser posts to /sign-up/finish for `options` (the creation options' publicKey). */
export function registration(passkey, options, origin) {
  const rpId = options.rp?.id ?? new URL(origin).hostname;
  const flags = 0x01 | 0x04 | 0x40; // user present, user verified, attested credential data
  const length = Buffer.alloc(2);
  length.writeUInt16BE(passkey.id.length);
  const auth = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), length, passkey.id, passkey.cose]);
  return {
    id: b64url(passkey.id), rawId: b64url(passkey.id), type: 'public-key',
    response: {
      clientDataJSON: b64url(clientData('webauthn.create', options.challenge, origin)),
      authenticatorData: b64url(auth), publicKey: b64url(passkey.spki), publicKeyAlgorithm: -7,
      transports: ['internal'],
    },
  };
}

/** The assertion a browser posts to /passkey/finish for `options` (the request options). */
export function assertion(passkey, options, origin) {
  passkey.counter += 1;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(passkey.counter);
  const auth = Buffer.concat([sha256(options.rpId), Buffer.from([0x01 | 0x04]), counter]);
  const client = clientData('webauthn.get', options.challenge, origin);
  const signature = sign('sha256', Buffer.concat([auth, sha256(client)]), passkey.privateKey);
  return {
    id: b64url(passkey.id), rawId: b64url(passkey.id), type: 'public-key', purpose: 'sign-in',
    response: { clientDataJSON: b64url(client), authenticatorData: b64url(auth), signature: b64url(signature) },
  };
}

/** Sign up, sign in and read, at `origin`. Answers { origin, address, steps: [{ step, status }], signed_in_read }. */
export async function checkASignUp(origin, { fetchImpl = fetch } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw Object.assign(new Error('ORIGIN is https://host with no path.'), { exit: 2 });
  const steps = [];
  const ask = async (step, path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetchImpl(`${origin}${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { ...(body && { 'content-type': 'application/json', origin }), ...(cookie && { cookie }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    steps.push({ step, status: response.status });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, setCookie: response.headers.get('set-cookie') };
  };
  const done = (address = null, read = false) => ({ origin, address, steps, signed_in_read: read });
  const page = await ask('sign-up page', '/sign-up');
  if (page.status !== 200) return done();
  const options = await ask('sign-up options', '/sign-up/options', { method: 'POST', body: {} });
  const creation = options.json?.options?.publicKey ?? options.json?.options;
  if (options.status !== 200 || !creation?.challenge) return done();
  const passkey = softwarePasskey();
  const finish = await ask('sign-up finish', '/sign-up/finish', { method: 'POST', body: registration(passkey, creation, origin) });
  const address = finish.json?.address;
  if (finish.status !== 200 || !/^[0-9a-f]{64}$/.test(address ?? '')) return done();
  const base = `/a/${address}`;
  const request = await ask('sign-in options', `${base}/passkey/options`, { method: 'POST', body: { purpose: 'sign-in' } });
  const requestOptions = request.json?.publicKey ?? request.json;
  if (request.status !== 200 || !requestOptions?.challenge) return done(address);
  const signIn = await ask('sign-in finish', `${base}/passkey/finish`, { method: 'POST', body: assertion(passkey, requestOptions, origin) });
  const cookie = signIn.setCookie?.split(';')[0];
  if (signIn.status !== 200 || !cookie) return done(address);
  const read = await ask('signed-in read', `${base}/sign-in/security`, { cookie });
  const without = await ask('read without the session', `${base}/sign-in/security`);
  return done(address, read.status === 200 && without.status !== 200);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [origin] = process.argv.slice(2);
  try {
    if (!origin || process.argv.length !== 3) throw Object.assign(new Error('usage: check-a-sign-up.mjs ORIGIN'), { exit: 2 });
    const answer = await checkASignUp(origin);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    if (!answer.signed_in_read) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
