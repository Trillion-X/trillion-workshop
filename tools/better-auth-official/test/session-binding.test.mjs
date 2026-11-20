// tools/better-auth-official/test/session-binding.test.mjs
//
// Better Auth issue #11461 (a pass bound to its session): what a renewal gives after the browser session it began in has ended, on a
// made-up account of a scratch store. Measured here, not assumed: the answer and whether our engine's standing check admits the pass.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'session-binding-'));
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
const { signedQuery } = await import('../pages/oauth-query.mjs');

const DAY = 86400;
const ORIGIN = settings.base_url;
const REDIRECT = 'http://127.0.0.1:9/callback';
let from = 0;
const call = (path, { body, cookie, form } = {}) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: body || form ? 'POST' : 'GET',
  headers: { origin: ORIGIN, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-forwarded-for': `198.51.100.${(from++ % 250) + 1}`, ...(cookie ? { cookie } : {}) },
  body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
}));
const up = await call('/sign-up/email', { body: { email: 'idle@example.test', password: 'scratch-password-123', name: 'Scratch' } });
let cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function newClient(name, uri) {
  const id = (await (await call('/oauth2/create-client', { cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: name } })).json()).client_id;
  if (uri) await pool.query('update "oauthClient" set uri = $1 where "clientId" = $2', [uri, id]);
  return id;
}
async function connect(clientId) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid wake:* offline_access', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const location = (await call(`/oauth2/authorize?${query}`, { cookie })).headers.get('location');
  const answered = await (await call('/oauth2/consent', { cookie, body: { accept: true, oauth_query: signedQuery(new URL(location, ORIGIN).search) } })).json();
  const code = new URL(answered.url).searchParams.get('code');
  return (await call('/oauth2/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: settings.mcp.resource } })).json();
}
const refresh = (clientId, token) => call('/oauth2/token', { form: { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: settings.mcp.resource } });
// Time passes: every token this AI holds was made, and ends, `days` earlier than it was.
const older = async (clientId, days) => {
  await pool.query('update "oauthConsent" set "createdAt" = "createdAt" - make_interval(days => $2), "updatedAt" = "updatedAt" - make_interval(days => $2) where "clientId" = $1', [clientId, days]);
  return pool.query('update "oauthRefreshToken" set "createdAt" = "createdAt" - make_interval(days => $2), "expiresAt" = "expiresAt" - make_interval(days => $2) where "clientId" = $1', [clientId, days]);
};
const expiry = async clientId => (await pool.query('select max("expiresAt") as at from "oauthRefreshToken" where "clientId" = $1 and revoked is null', [clientId])).rows[0].at.getTime();
const listed = async clientId => (await (await call('/connected', { cookie })).json()).ais.find(ai => ai.client_id === clientId);


const { credentialStands } = await import('../credential-standing.mjs');
const claimsOf = pass => JSON.parse(Buffer.from(pass.split('.')[1], 'base64url').toString('utf8'));

let accounts = 0;
const renewalAfter = async makeEnded => {
  // Each case is a made-up account of its own, so ending one's session never ends another's.
  accounts += 1;
  cookie = (await call('/sign-up/email', { body: { email: `bound${accounts}@example.test`, password: 'scratch-password-123', name: 'Scratch' } })).headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const client = await newClient('Binding AI');
  const first = await connect(client);
  const sid = claimsOf(first.access_token).sid;
  await makeEnded(sid);
  const answer = await refresh(client, first.refresh_token);
  const body = await answer.json();
  return { status: answer.status, error: body.error, sameSession: body.access_token ? claimsOf(body.access_token).sid === sid : null,
    stands: await credentialStands(auth, settings.credential_standing, `mcp-access:${(await (await auth.$context).internalAdapter.findUserByEmail(`bound${accounts}@example.test`)).user.id}:${client}`) };
};

// Measured on better-auth 1.7.25 (the version this tool pins): the binding of #11461 does not end a sign-in.
test('a renewal after the session it began in has expired still gives a pass, and the engine\'s standing check admits it', async () => {
  const renewed = await renewalAfter(sid => pool.query('update "session" set "expiresAt" = now() - interval \'1 day\' where id = $1', [sid]));
  assert.deepEqual(renewed, { status: 200, error: undefined, sameSession: true, stands: true });
});

test('a renewal after the session row is gone (signed out, or cleaned up) gives a pass of a new session, and the standing check admits it', async () => {
  const renewed = await renewalAfter(sid => pool.query('delete from "session" where id = $1', [sid]));
  assert.deepEqual(renewed, { status: 200, error: undefined, sameSession: false, stands: true });
});
