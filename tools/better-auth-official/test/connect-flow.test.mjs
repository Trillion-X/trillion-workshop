// tools/better-auth-official/test/connect-flow.test.mjs
//
// What the connect pages stand on, against the real Better Auth: an AI's authorize request without a session goes to the
// sign-in page with a signed query; the sign-in pages carry it (oauth-query.mjs) through the email code and the passkey step
// (/sign-in/add-passkey), and when the person is signed in the same request, without its signature parts, goes back to
// authorize, which asks consent at /consent; Allow and Deny answer with the AI's own redirect. A device's user code (RFC 8628)
// is claimed by the person who opens it, who sees its client and scopes, and approves or denies it.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'connect-flow-'));
const settings = { ...JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')), email_password: { require_verification: false }, disabled_paths: [] };
writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
process.env.BETTER_AUTH_SETTINGS = join(dir, 'settings.json');
const store = await startStore();
process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth, pool } = await import('../auth.mjs');
store.hold(pool);
test.after(() => store.stop());
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();
const { authorizeQuery, signedQuery } = await import('../pages/oauth-query.mjs');
const { default: words } = await import('../pages/words.json', { with: { type: 'json' } });

const ORIGIN = settings.base_url;
const REDIRECT = 'http://127.0.0.1:9/callback';
const call = (path, { body, cookie, from } = {}) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: body ? 'POST' : 'GET', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(from ? { 'x-forwarded-for': from } : {}) }, body: body && JSON.stringify(body),
}));
const cookieOf = response => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const person = await call('/sign-up/email', { body: { email: 'connect@example.test', password: 'scratch-password-123', name: 'Scratch' } });
const cookie = cookieOf(person);
const client = await (await call('/oauth2/create-client', { cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'Scratch AI' } })).json();
const request = (extra = {}) => new URLSearchParams({
  response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, scope: 'openid wake:* tools:*', state: 'asked',
  code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource, ...extra,
});
const searchOf = location => new URL(location, ORIGIN).search;
const goTo = async (url, headers = {}) => { const answer = await auth.handler(new Request(new URL(url, ORIGIN), { headers })); return answer.headers.get('location') ?? ''; };

test('an authorize request with no session goes to the sign-in page with a signed query the pages can carry on', async () => {
  const location = await goTo(`${settings.base_path}/oauth2/authorize?${request()}`);
  assert.ok(location.startsWith(settings.mcp.login_page), location);
  const carried = new URLSearchParams(signedQuery(searchOf(location)));
  assert.ok(carried.has('sig'));
  assert.equal(carried.get('client_id'), client.client_id);
  // A page that is not an authorize sign-in carries nothing.
  assert.equal(signedQuery('?email=someone@example.test&way=email-code'), '');
  assert.equal(signedQuery('?client_id=x&sig=y'), '', 'a query that names no signed parameters is not a signed query');
});

test('the request authorize gets back is the AI\'s own, without the signature parts and without prompt=login', async () => {
  const sent = request({ prompt: 'login consent' });
  const location = await goTo(`${settings.base_path}/oauth2/authorize?${sent}`);
  const back = new URLSearchParams(authorizeQuery(searchOf(location)));
  for (const [key, value] of sent) if (!['prompt', 'scope'].includes(key)) assert.equal(back.get(key), value, key);
  assert.equal(back.get('scope'), `${sent.get('scope')} offline_access tools:list`, 'the scope is the AI\'s own, with the offline_access that keeps the person connected and the read-only variants Read only chooses');
  assert.equal(back.get('prompt'), 'consent');
  for (const key of ['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl']) assert.ok(!back.has(key), `${key} is left out`);
  assert.equal(new URLSearchParams(authorizeQuery(searchOf(await goTo(`${settings.base_path}/oauth2/authorize?${request({ prompt: 'login' })}`)))).get('prompt'), 'consent', 'login is taken out, and consent, which every connect goes through, stays');
});

test('the sign-in page names the AI before sign-in, from the signed query only', async () => {
  const query = signedQuery(searchOf(await goTo(`${settings.base_path}/oauth2/authorize?${request()}`)));
  const named = await (await call('/oauth2/public-client-prelogin', { body: { client_id: client.client_id, oauth_query: query } })).json();
  assert.equal(named.client_name, 'Scratch AI');
  const other = await call('/oauth2/public-client-prelogin', { body: { client_id: 'some-other-client', oauth_query: query } });
  assert.ok([400, 401].includes(other.status), 'a signed query for one client names no other');
  assert.ok([400, 401].includes((await call('/oauth2/public-client-prelogin', { body: { client_id: client.client_id, oauth_query: 'client_id=x' } })).status), 'an unsigned query names nobody');
});

test('after sign-in, and after the passkey step, the carried request resumes: authorize asks consent, Allow gives the AI its code, Deny its refusal', async () => {
  const location = await goTo(`${settings.base_path}/oauth2/authorize?${request({ prompt: 'login' })}`);
  // The page carried the signed query through /sign-in, the email code and /sign-in/add-passkey, and now sends the request back.
  const resumed = await goTo(`${settings.base_path}/oauth2/authorize?${authorizeQuery(searchOf(location))}`, { cookie });
  assert.ok(resumed.startsWith(settings.mcp.consent_page), `consent is asked at ${settings.mcp.consent_page}: ${resumed}`);
  const consentQuery = searchOf(resumed);
  assert.equal(new URLSearchParams(consentQuery).get('client_id'), client.client_id);
  assert.equal(new URLSearchParams(consentQuery).get('scope'), 'openid wake:* tools:* offline_access tools:list');
  assert.equal((await (await call(`/oauth2/public-client?client_id=${client.client_id}`, { cookie })).json()).client_name, 'Scratch AI');
  const allowed = await (await call('/oauth2/consent', { cookie, body: { accept: true, oauth_query: signedQuery(consentQuery) } })).json();
  const back = new URL(allowed.url);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.ok(back.searchParams.get('code'), 'the AI gets its authorization code');
  assert.equal(back.searchParams.get('state'), 'asked');

  const other = await (await call('/oauth2/create-client', { cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'Another AI' } })).json();
  const asked = await goTo(`${settings.base_path}/oauth2/authorize?${request({ client_id: other.client_id })}`, { cookie });
  const denied = await (await call('/oauth2/consent', { cookie, body: { accept: false, oauth_query: signedQuery(searchOf(asked)) } })).json();
  assert.equal(new URL(denied.url).searchParams.get('error'), 'access_denied');
});

test('a device\'s code is claimed by the person who opens it, who sees its client and scopes and approves or denies it', async () => {
  const issued = await (await call('/device/code', { body: { client_id: 'a-device', scope: 'wake:* tools:*' } })).json();
  assert.equal(new URL(issued.verification_uri, ORIGIN).pathname, settings.device.verification_uri);
  assert.deepEqual(await (await call(`/device?user_code=${issued.user_code}`)).json(), { user_code: issued.user_code, status: 'pending' }, 'with no session nothing but its status is shown');
  const seen = await (await call(`/device?user_code=${issued.user_code}`, { cookie })).json();
  assert.equal(seen.client_id, 'a-device');
  assert.equal(seen.scope, 'wake:* tools:*');
  assert.equal((await call('/device/approve', { cookie, body: { userCode: issued.user_code } })).status, 200);
  assert.equal((await (await call(`/device?user_code=${issued.user_code}`, { cookie })).json()).status, 'approved');
  const refused = await (await call('/device/code', { body: { client_id: 'a-device', scope: 'wake:*' } })).json();
  await call(`/device?user_code=${refused.user_code}`, { cookie });
  assert.equal((await call('/device/deny', { cookie, body: { userCode: refused.user_code } })).status, 200);
  assert.equal((await (await call(`/device?user_code=${refused.user_code}`, { cookie })).json()).status, 'denied');
  assert.equal((await call('/device?user_code=NOSUCHCODE', { cookie, from: '203.0.113.9' })).status, 400);
});

test('every scope a client may ask for has its plain words on the consent page', () => {
  for (const scope of settings.mcp.scopes) assert.ok(words.scopes[scope], `${scope} has words`);
});
