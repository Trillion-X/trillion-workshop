// tools/better-auth-official/test/store-shared-by-processes.test.mjs
//
// Two Better Auth processes on one Postgres store, as two computers behind the sign-in name run (test-fixtures/two-processes.mjs):
// a passkey sign-in asked on process A finishes on process B, and a session made on B is read on A; an email code, an
// authorization code and a refresh token each work exactly once, whichever process is asked and even when both are asked at the
// same moment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';
import { startTwoProcesses, cookieOf } from '../test-fixtures/two-processes.mjs';

const store = await startStore();
const connection = await store.database();
// The shipped resource scopes leave out offline_access, so a refresh grant narrows to `records` and issues no new refresh token; rotation
// needs it listed, as here.
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const pair = await startTwoProcesses(connection, { mcp: { ...shipped.mcp, resource_scopes: [...shipped.mcp.resource_scopes, 'offline_access'] } });
const { a, b, call, mail, origin, settings } = pair;

const base64url = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = bytes => createHash('sha256').update(bytes).digest();
const PASSWORD = 'scratch-password-123';

const up = await call(a, '/sign-up/email', { body: { email: 'shared@example.test', password: PASSWORD, name: 'Shared' } });
assert.equal(up.status, 200);
const person = (await up.json()).user;
const cookie = cookieOf(up);

// The passkey's public key as the COSE map an authenticator makes (ES256), and a row for it in the shared store, which is what
// finishing a registration leaves; the sign-in below is the ceremony itself.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y, 'base64url')]);
const credentialId = base64url(randomBytes(32));
const { default: pg } = await import('pg');
const sql = new pg.Pool({ connectionString: connection });
test.after(async () => { await sql.end(); pair.stop(); await store.stop(); });
await sql.query('insert into passkey (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", transports, "createdAt") values ($1, $2, $3, $4, $5, 0, $6, false, $7, now())',
  ['passkey-1', 'scratch', cose.toString('base64'), person.id, credentialId, 'singleDevice', 'internal']);

// What an authenticator answers for a challenge: authenticator data (rp id hash, user present and verified, counter), the client data
// naming the challenge and origin, and the signature over both.
function assertion(challenge, counter) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
  const authenticatorData = Buffer.concat([sha256(settings.passkey.rp_id), Buffer.from([0x05]), Buffer.from([0, 0, 0, counter])]);
  const signature = createSign('sha256').update(Buffer.concat([authenticatorData, sha256(clientDataJSON)])).sign(privateKey);
  return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: base64url(clientDataJSON), authenticatorData: base64url(authenticatorData), signature: base64url(signature) } };
}
const asked = async process => {
  const options = await call(process, '/passkey/generate-authenticate-options');
  assert.equal(options.status, 200);
  return { challenge: (await options.json()).challenge, cookie: cookieOf(options) };
};

test('a passkey sign-in asked on process A finishes on process B, and the session B made is read on A', async () => {
  const { challenge, cookie: ceremony } = await asked(a);
  const done = await call(b, '/passkey/verify-authentication', { body: { response: assertion(challenge, 1) }, cookie: ceremony });
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal((await done.json()).user.id, person.id);
  const seen = await (await call(a, '/get-session', { cookie: cookieOf(done) })).json();
  assert.equal(seen.user.id, person.id);
});

test('a passkey challenge is used once: finishing the same ceremony again, on either process, fails', async () => {
  const { challenge, cookie: ceremony } = await asked(b);
  const answer = assertion(challenge, 2);
  assert.equal((await call(a, '/passkey/verify-authentication', { body: { response: answer }, cookie: ceremony })).status, 200);
  assert.equal((await call(a, '/passkey/verify-authentication', { body: { response: answer }, cookie: ceremony })).status, 400);
  assert.equal((await call(b, '/passkey/verify-authentication', { body: { response: answer }, cookie: ceremony })).status, 400);
});

test('an email code is used once: asked on A, used on B and on A at the same moment, exactly one is let in; a later use fails', async () => {
  const sent = await call(a, '/email-otp/send-verification-otp', { body: { email: 'shared@example.test', type: 'sign-in' } });
  assert.equal(sent.status, 200);
  const otp = mail(a).filter(row => row.otp).at(-1).otp;
  const answers = await Promise.all([a, b, a, b].map(process => call(process, '/sign-in/email-otp', { body: { email: 'shared@example.test', otp } })));
  assert.equal(answers.filter(answer => answer.status === 200).length, 1, answers.map(answer => answer.status).join());
  assert.notEqual((await call(b, '/sign-in/email-otp', { body: { email: 'shared@example.test', otp } })).status, 200);
});

// An AI that signs in through the OAuth server: a client, the consent of a person (another one than above, whose sessions the email code
// sign-in clears), then the code and refresh token it gets.
const consenting = cookieOf(await call(a, '/sign-up/email', { body: { email: 'consenting@example.test', password: PASSWORD, name: 'Consenting' } }));
const verifier = base64url(randomBytes(32));
const REDIRECT = 'http://127.0.0.1:9/callback';
async function authorized() {
  const client = await (await call(a, '/oauth2/create-client', { cookie: consenting, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'Scratch AI' } })).json();
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, scope: 'openid offline_access records', state: 's', code_challenge: base64url(sha256(verifier)), code_challenge_method: 'S256', resource: settings.mcp.resource });
  // Asked by fetch, Better Auth answers the redirect as JSON {url}.
  const toConsent = await (await call(a, `/oauth2/authorize?${query}`, { cookie: consenting })).json();
  const signed = new URL(toConsent.url, origin).search;
  const allowed = await (await call(a, '/oauth2/consent', { cookie: consenting, body: { accept: true, oauth_query: signed.slice(1) } })).json();
  return { client, code: new URL(allowed.url).searchParams.get('code') };
}
const tokens = (process, client, form) => call(process, '/oauth2/token', { form: { client_id: client.client_id, redirect_uri: REDIRECT, ...form } });

test('an authorization code is used once: given on A, redeemed on A and B at the same moment, exactly one gets tokens', async () => {
  const { client, code } = await authorized();
  assert.ok(code, 'the AI is given a code');
  const answers = await Promise.all([a, b, b, a].map(process => tokens(process, client, { grant_type: 'authorization_code', code, code_verifier: verifier })));
  assert.equal(answers.filter(answer => answer.status === 200).length, 1, (await Promise.all(answers.map(answer => answer.clone().text()))).join('\n'));
  assert.notEqual((await tokens(b, client, { grant_type: 'authorization_code', code, code_verifier: verifier })).status, 200);
});

const refreshed = (process, client, token) => tokens(process, client, { grant_type: 'refresh_token', refresh_token: token });

test('a refresh token rotates once: the new one made on B works on A, the old one answered again on A is the same new token, and past its replay window it is refused', async () => {
  const { client, code } = await authorized();
  const first = await (await tokens(a, client, { grant_type: 'authorization_code', code, code_verifier: verifier })).json();
  assert.ok(first.refresh_token, 'offline_access gives a refresh token');
  const rotated = await (await refreshed(b, client, first.refresh_token)).json();
  assert.ok(rotated.refresh_token && rotated.refresh_token !== first.refresh_token, 'a new refresh token');
  assert.equal((await (await refreshed(a, client, first.refresh_token)).json()).refresh_token, rotated.refresh_token, 'the same answer within the replay window, not a second rotation');
  assert.equal((await sql.query('select count(*)::int as n from "oauthRefreshToken" where "clientId" = $1', [client.client_id])).rows[0].n, 2, 'the first token and its one successor');
  // The replay window is Better Auth's own row (rotationReplayExpiresAt); once it has passed, the used token is refused on both processes.
  await sql.query('update "oauthRefreshToken" set "rotationReplayExpiresAt" = now() - interval \'1 second\' where "clientId" = $1 and "rotatedAt" is not null', [client.client_id]);
  for (const process of [a, b]) assert.equal((await refreshed(process, client, first.refresh_token)).status, 400);
});

test('a refresh token asked for on A and B at the same moment rotates for exactly one of them', async () => {
  const { client, code } = await authorized();
  const first = await (await tokens(b, client, { grant_type: 'authorization_code', code, code_verifier: verifier })).json();
  const answers = await Promise.all([a, b, b, a].map(process => refreshed(process, client, first.refresh_token)));
  assert.equal(answers.filter(answer => answer.status === 200).length, 1, answers.map(answer => answer.status).join());
  assert.equal((await sql.query('select count(*)::int as n from "oauthRefreshToken" where "clientId" = $1', [client.client_id])).rows[0].n, 2);
});

test('a session read is answered from the signed cookie for cookie_cache_seconds; asking the store sees a session that has ended', async () => {
  const signed = await call(b, '/sign-in/email', { body: { email: 'consenting@example.test', password: PASSWORD } });
  const held = cookieOf(signed);
  const token = (await signed.json()).token;
  await sql.query('delete from session where token = $1', [token]);
  assert.equal((await (await call(a, '/get-session', { cookie: held })).json())?.user?.email, 'consenting@example.test', 'the signed cookie answers');
  assert.equal(await (await call(a, '/get-session?disableCookieCache=true', { cookie: held })).json(), null, 'the store says it ended');
});
