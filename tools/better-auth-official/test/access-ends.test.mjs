// tools/better-auth-official/test/access-ends.test.mjs
//
// An AI's access ends when it goes unused (access-lifetime plan A1): each refresh makes a refresh token that lives
// unusedSeconds (access-ends-when-unused.json) from that moment, so an AI used at least once in that time never loses access and one
// left alone loses it; a refresh token used a second time ends the whole chain; and the connected list says which AIs have ended,
// why, when they were last used, and where one tap reconnects them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = mkdtempSync(join(tmpdir(), 'access-ends-'));
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

const { unusedSeconds: IDLE, unusedDays } = await import('../../share-anything/read-data/access-ends-when-unused.mjs');
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
const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function newClient(name, uri) {
  const id = (await (await call('/oauth2/create-client', { cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: name } })).json()).client_id;
  if (uri) await pool.query('update "oauthClient" set uri = $1 where "clientId" = $2', [uri, id]);
  return id;
}
async function connect(clientId) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid records offline_access', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const location = (await call(`/oauth2/authorize?${query}`, { cookie })).headers.get('location');
  const answered = await (await call('/oauth2/consent', { cookie, body: { accept: true, oauth_query: signedQuery(new URL(location, ORIGIN).search) } })).json();
  const code = new URL(answered.url).searchParams.get('code');
  return (await call('/oauth2/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: settings.mcp.resource } })).json();
}
const refresh = (clientId, token) => call('/oauth2/token', { form: { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: settings.mcp.resource } });
// Time passes: every token this AI holds was made, and ends, `days` earlier than it was.
const older = (clientId, days) => pool.query('update "oauthRefreshToken" set "createdAt" = "createdAt" - make_interval(days => $2), "expiresAt" = "expiresAt" - make_interval(days => $2) where "clientId" = $1', [clientId, days]);
const expiry = async clientId => (await pool.query('select max("expiresAt") as at from "oauthRefreshToken" where "clientId" = $1 and revoked is null', [clientId])).rows[0].at.getTime();
const listed = async clientId => (await (await call('/connected', { cookie })).json()).ais.find(ai => ai.client_id === clientId);

test('the idle window is the number the rule file holds: a new refresh token ends that many seconds after it was made', async () => {
  const client = await newClient('Fresh AI');
  const token = await connect(client);
  const left = (await expiry(client) - Date.now()) / 1000;
  assert.ok(Math.abs(left - IDLE) < 60, `${left} seconds left, ${IDLE} wanted`);
  assert.equal(IDLE, 90 * DAY);
});

test('an AI used on day 89 has the whole window again: refreshing then finds the new token ending about 90 days out', async () => {
  const client = await newClient('Weekly AI');
  const token = await connect(client);
  await older(client, 89);
  assert.ok(await expiry(client) - Date.now() < 2 * DAY * 1000, 'one day was left');
  const answer = await refresh(client, token.refresh_token);
  assert.equal(answer.status, 200);
  const left = (await expiry(client) - Date.now()) / 1000;
  assert.ok(Math.abs(left - IDLE) < 60, `${left} seconds left after the refresh`);
});

test('an AI used every day for 100 days never loses access', async () => {
  const client = await newClient('Daily AI');
  let token = await connect(client);
  for (let day = 0; day < 100; day++) {
    await older(client, 1);
    await pool.query('update "oauthRefreshToken" set "rotationReplayExpiresAt" = now() - interval \'1 second\' where "clientId" = $1 and "rotatedAt" is not null', [client]);
    const answer = await refresh(client, token.refresh_token);
    assert.equal(answer.status, 200, `day ${day + 1}`);
    token = await answer.json();
  }
  assert.equal((await listed(client)).ended_by, null);
});

test('an AI unused for 90 days has lost access: the refresh is refused and the list says so, with when, last use and where to reconnect', async () => {
  const client = await newClient('Idle AI', 'https://idle-ai.example.test/connect');
  const token = await connect(client);
  const usedAt = (await listed(client)).last_used_at;
  await older(client, 91);
  assert.equal((await refresh(client, token.refresh_token)).status, 400);
  const ai = await listed(client);
  assert.equal(ai.ended_by, 'unused');
  assert.equal(ai.ended_text, `Access ended: not used for ${unusedDays} days.`);
  assert.ok(new Date(ai.ended_at) < new Date(), 'it ended in the past');
  assert.ok(new Date(ai.last_used_at) < new Date(usedAt), 'last used is when its newest refresh token was made');
  assert.equal(ai.reconnect_url, 'https://idle-ai.example.test/connect');
  const quiet = await listed(await newClient('Quiet AI')).catch(() => undefined);
  assert.equal(quiet, undefined, 'an AI that never connected is not listed');
});

test('an AI with no address of its own to open gets no reconnect link, and a non-https address is never offered', async () => {
  for (const [name, uri] of [['No address AI', null], ['Script address AI', 'javascript:alert(1)']]) {
    const client = await newClient(name, uri);
    const token = await connect(client);
    await older(client, 91);
    const ai = await listed(client);
    assert.equal(ai.ended_by, 'unused');
    assert.equal(ai.reconnect_url, null);
    assert.ok(token.refresh_token);
  }
});

test('a refresh token used a second time ends the whole chain, the newer token too, and the list says the access ended', async () => {
  const client = await newClient('Copied AI');
  const first = await connect(client);
  const second = await (await refresh(client, first.refresh_token)).json();
  await pool.query('update "oauthRefreshToken" set "rotationReplayExpiresAt" = now() - interval \'1 second\' where "clientId" = $1 and "rotatedAt" is not null', [client]);
  assert.equal((await refresh(client, first.refresh_token)).status, 400, 'the old token again');
  assert.equal((await refresh(client, second.refresh_token)).status, 400, 'and the token that replaced it');
  assert.equal((await listed(client)).ended_by, 'chain_ended');
});

test('revoking ends consent and every token at once, an ended AI included, and a refresh asked for after it gets nothing, even inside the replay window', async () => {
  const client = await newClient('Revoked AI');
  const first = await connect(client);
  const second = await (await refresh(client, first.refresh_token)).json();
  assert.equal((await call('/connected/revoke', { cookie, body: { clientId: client } })).status, 200);
  assert.equal(await listed(client), undefined);
  assert.equal((await pool.query('select count(*)::int as n from "oauthConsent" where "clientId" = $1', [client])).rows[0].n, 0);
  assert.equal((await pool.query('select count(*)::int as n from "oauthAccessToken" where "clientId" = $1', [client])).rows[0].n, 0);
  for (const token of [first, second]) assert.notEqual((await refresh(client, token.refresh_token)).status, 200);
  const ended = await newClient('Ended then revoked AI');
  await connect(ended);
  await older(ended, 91);
  assert.equal((await call('/connected/revoke', { cookie, body: { clientId: ended } })).status, 200);
  assert.equal(await listed(ended), undefined, 'one tap clears an ended AI from the list');
});

test('the number of days is held once: no file of this tool carries it (the first test shows Better Auth was given the rule file\'s)', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const held = [];
  const walk = folder => { for (const name of readdirSync(folder)) { if (name === 'node_modules' || name === 'data') continue; const path = join(folder, name); if (statSync(path).isDirectory()) walk(path); else if (!path.endsWith('access-ends.test.mjs') && /\b(7776000|refresh_token_idle_seconds)\b/.test(readFileSync(path, 'utf8'))) held.push(path); } };
  walk(new URL('..', import.meta.url).pathname);
  assert.deepEqual(held, [], 'the days live in access-ends-when-unused.json only');
});
