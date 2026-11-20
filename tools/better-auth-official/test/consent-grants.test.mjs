// tools/better-auth-official/test/consent-grants.test.mjs
//
// What a person can do about the AIs connected to them (data-access plan D1): every connect goes to the consent page, even for an AI they
// already allowed (where it is shown "Connecting" with an Undo); the owner's AI gets everything and Read only is a switch that grants less;
// the connected AIs are listed with what each can do and when it last used its pass; one write disconnects one so its pass stops standing
// and its refresh token stops working; and a consent answered from another site is refused.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'consent-grants-'));
const settings = { ...JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')), mcp: { ...JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')).mcp, first_party_clients: ['https://first-party.example.test/client.json'] }, email_password: { require_verification: false }, disabled_paths: [] };
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
const { credentialStands } = await import('../credential-standing.mjs');
const { default: rules } = await import('../pages/sign-in-rules.json', { with: { type: 'json' } });

const ORIGIN = settings.base_url;
const REDIRECT = 'http://127.0.0.1:9/callback';
let from = 0;
const call = (path, { body, cookie, origin = ORIGIN, form } = {}) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: body || form ? 'POST' : 'GET',
  headers: { ...(origin ? { origin } : {}), 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-forwarded-for': `198.51.100.${(from++ % 250) + 1}`, ...(cookie ? { cookie } : {}) },
  body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
}));
const up = await call('/sign-up/email', { body: { email: 'grants@example.test', password: 'scratch-password-123', name: 'Scratch' } });
const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const user = (await (await auth.$context).internalAdapter.findUserByEmail('grants@example.test')).user;

async function newClient(name) {
  return (await (await call('/oauth2/create-client', { cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: name } })).json()).client_id;
}
// An AI's connect to the end: authorize, the consent screen's answer (readOnly: the switch), the code, the tokens.
async function connect(clientId, { readOnly = false, scope = 'openid wake:* tools:* secrets:*' } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const asked = await call(`/oauth2/authorize?${query}`, { cookie });
  const location = asked.headers.get('location');
  assert.ok(location.startsWith(settings.mcp.consent_page), `every connect goes to the consent page: ${location}`);
  const answered = await (await call('/oauth2/consent', { cookie, body: { accept: true, read_only: readOnly, oauth_query: signedQuery(new URL(location, ORIGIN).search) } })).json();
  const code = new URL(answered.url).searchParams.get('code');
  assert.ok(code, answered.url);
  const token = await (await call('/oauth2/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: settings.mcp.resource } })).json();
  return { token, location };
}

test('the owner\'s AI gets everything it asked for, and Read only swaps each scope that has a read variant for it and drops the scopes the rules drop', async () => {
  const full = await newClient('Full AI');
  const { token } = await connect(full);
  const everything = token.scope.split(' ');
  for (const scope of ['wake:*', 'tools:*', 'secrets:*']) assert.ok(everything.includes(scope), `${scope} is granted to the owner's AI`);
  for (const variant of Object.values(rules.read_only_swaps)) assert.ok(!everything.includes(variant), `${variant} is not added to a full grant`);
  const narrow = await newClient('Reading AI');
  const granted = (await connect(narrow, { readOnly: true })).token.scope.split(' ');
  for (const [fullScope, variant] of Object.entries(rules.read_only_swaps)) { assert.ok(!granted.includes(fullScope), `${fullScope} is not granted when Read only is on`); assert.ok(granted.includes(variant), `${variant} is`); }
  for (const dropped of rules.read_only_drops) assert.ok(!granted.includes(dropped), `${dropped} is not granted when Read only is on`);
  assert.ok(granted.includes('tools:list'), 'what only reads is given in place of what runs');
});

test('the connected AIs are listed with their name, what they can do and when they last used their pass; a remembered AI is asked about again', async () => {
  const listed = (await (await call('/connected', { cookie })).json()).ais;
  const byName = Object.fromEntries(listed.map(ai => [ai.name, ai]));
  assert.equal(byName['Full AI'].read_only, false);
  assert.equal(byName['Reading AI'].read_only, true);
  assert.ok(byName['Full AI'].last_used_at && byName['Full AI'].connected_at);
  assert.equal((await call('/connected')).status, 401, 'a stranger sees nothing');
  const again = await call(`/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: byName['Full AI'].client_id, redirect_uri: REDIRECT, scope: 'openid wake:*', state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: settings.mcp.resource })}`, { cookie });
  assert.ok(again.headers.get('location').startsWith(settings.mcp.consent_page), 'an AI the person allowed still goes through the consent page, which shows it Connecting with an Undo');
  const consents = await (await call('/oauth2/get-consents', { cookie })).json();
  assert.ok(consents.some(consent => consent.clientId === byName['Full AI'].client_id), 'and the page can see it was allowed');
});

test('one write disconnects an AI: its pass stops standing, its refresh token stops working, it asks again, and only that AI is touched', async () => {
  const goner = await newClient('Goner AI'), keeper = await newClient('Keeper AI');
  const { token } = await connect(goner, { scope: 'openid wake:* offline_access' });
  await connect(keeper, { scope: 'openid wake:* offline_access' });
  const standing = settings.credential_standing;
  assert.equal((await credentialStands(auth, standing, `mcp-access:${user.id}:${goner}`)), true);
  const done = await call('/connected/revoke', { cookie, body: { clientId: goner } });
  assert.equal(done.status, 200);
  assert.equal((await credentialStands(auth, standing, `mcp-access:${user.id}:${goner}`)), false);
  assert.equal((await credentialStands(auth, standing, `mcp-access:${user.id}:${keeper}`)), true);
  const refresh = await call('/oauth2/token', { form: { grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: goner, resource: settings.mcp.resource } });
  assert.notEqual(refresh.status, 200, 'the refresh token no longer works');
  const names = (await (await call('/connected', { cookie })).json()).ais.map(ai => ai.name);
  assert.ok(!names.includes('Goner AI') && names.includes('Keeper AI'));
  assert.equal((await call('/connected/revoke', { body: { clientId: keeper } })).status, 401, 'no one but the person ends it');
});

test('a consent answered from another site is refused, and nothing is allowed', async () => {
  const client = await newClient('Framed AI');
  const query = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, scope: 'openid wake:*', state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const location = (await call(`/oauth2/authorize?${query}`, { cookie })).headers.get('location');
  const body = { accept: true, oauth_query: signedQuery(new URL(location, ORIGIN).search) };
  for (const origin of ['https://evil.example', 'null']) {
    const answer = await call('/oauth2/consent', { cookie, body, origin });
    assert.equal(answer.status, 403, `Origin ${origin}`);
  }
  assert.equal((await call('/oauth2/consent', { cookie, body, origin: null })).status, 403, 'a cookie with no Origin at all');
  const consents = await (await call('/oauth2/get-consents', { cookie })).json();
  assert.ok(!consents.some(consent => consent.clientId === client), 'no consent was stored');
  const cookieHeader = up.headers.getSetCookie().find(c => c.startsWith('__Host-example_session'));
  assert.match(cookieHeader, /SameSite=Lax/i, 'the session cookie is not sent on another site\'s POST');
  assert.equal((await call('/oauth2/consent', { cookie, body })).status, 200, 'from this site it is answered');
});

test('The product\'s own programs are named in settings by their client document address, and the page can ask whether one is', async () => {
  const asked = async id => (await (await call(`/first-party?client_id=${encodeURIComponent(id)}`)).json()).first_party;
  assert.equal(await asked('https://first-party.example.test/client.json'), true);
  assert.equal(await asked('https://other.example.test/client.json'), false);
  assert.equal(await asked(''), false);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')).mcp.first_party_clients, [], 'the shared tool names no product: the computer that runs it does');
});

test('the limits are kept per person: the client address comes from the forwarded header past the front door\'s own addresses, so one person never uses another\'s bucket', async () => {
  const { getIP } = await import('@better-auth/core/utils/ip');
  const options = auth.options;
  const ask = forwarded => getIP(new Request(`${ORIGIN}/`, { headers: { 'x-forwarded-for': forwarded } }), options);
  assert.equal(ask('203.0.113.7'), '203.0.113.7');
  assert.equal(ask('203.0.113.7, 127.0.0.1'), '203.0.113.7', 'the front door\'s own hop is skipped');
  assert.equal(ask('198.51.100.9, 203.0.113.7'), '203.0.113.7', 'the hop that is not the front door\'s is the client, whatever a client wrote before it');
});
