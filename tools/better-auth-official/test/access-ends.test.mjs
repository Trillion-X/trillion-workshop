// tools/better-auth-official/test/access-ends.test.mjs
//
// An AI's access has no end by default (the account owner, Nov 17 2026): each refresh makes a token that lives settings.mcp.refresh_token_no_end_seconds. The person may
// set a limit of days unused for one AI (POST /connected/limit, kept on the consent row); each token made then lives that long from when it was made, so
// an AI used at least once in that time never loses access and one left alone loses it. A refresh token used a second time ends the whole chain, and the
// connected list says which AIs have ended, why, when they were last used, the limit, and where one tap reconnects them.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'access-ends-'));
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
const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

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
const limit = async (clientId, days) => { const answer = await call('/connected/limit', { cookie, body: { clientId, days } }); assert.equal(answer.status, 200, await answer.clone().text()); };
const refresh = (clientId, token) => call('/oauth2/token', { form: { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: settings.mcp.resource } });
// Time passes: every token this AI holds was made, and ends, `days` earlier than it was.
const older = async (clientId, days) => {
  await pool.query('update "oauthConsent" set "createdAt" = "createdAt" - make_interval(days => $2), "updatedAt" = "updatedAt" - make_interval(days => $2) where "clientId" = $1', [clientId, days]);
  return pool.query('update "oauthRefreshToken" set "createdAt" = "createdAt" - make_interval(days => $2), "expiresAt" = "expiresAt" - make_interval(days => $2) where "clientId" = $1', [clientId, days]);
};
const expiry = async clientId => (await pool.query('select max("expiresAt") as at from "oauthRefreshToken" where "clientId" = $1 and revoked is null', [clientId])).rows[0].at.getTime();
const listed = async clientId => (await (await call('/connected', { cookie })).json()).ais.find(ai => ai.client_id === clientId);

test('by default an AI\'s access has no end: its refresh token ends no sooner than the no-end date, and it is renewed after a year unused', async () => {
  const client = await newClient('Fresh AI');
  const token = await connect(client);
  const left = (await expiry(client) - Date.now()) / 1000;
  assert.ok(Math.abs(left - settings.mcp.refresh_token_no_end_seconds) < 60, `${left} seconds left`);
  assert.equal((await listed(client)).idle_limit_days, null);
  await older(client, 400);
  assert.equal((await refresh(client, token.refresh_token)).status, 200, 'unused for 400 days and still answered');
  assert.equal((await listed(client)).ended_by, null);
});

test('a limit the person sets for one AI ends its tokens that many days after they were made, and each use starts the days again', async () => {
  const client = await newClient('Limited AI');
  const other = await newClient('Unlimited AI');
  const token = await connect(client);
  await connect(other);
  await limit(client, 30);
  assert.ok(Math.abs((await expiry(client) - Date.now()) / 1000 - 30 * DAY) < 60, 'the token that existed now ends in 30 days');
  assert.ok((await expiry(other) - Date.now()) / 1000 > 365 * DAY, 'another AI is not touched');
  await older(client, 29);
  const answer = await refresh(client, token.refresh_token);
  assert.equal(answer.status, 200);
  assert.ok(Math.abs((await expiry(client) - Date.now()) / 1000 - 30 * DAY) < 60, 'the new token ends 30 days out again');
  assert.equal((await listed(client)).idle_limit_days, 30);
});

test('taking the limit away gives the AI no end again, and a limit that is not a whole number of days is refused', async () => {
  const client = await newClient('Cleared AI');
  await connect(client);
  await limit(client, 7);
  await limit(client, null);
  assert.ok((await expiry(client) - Date.now()) / 1000 > 365 * DAY);
  for (const days of [0, -3, 1.5, 'x']) assert.equal((await call('/connected/limit', { cookie, body: { clientId: client, days } })).status, 400, String(days));
  assert.equal((await call('/connected/limit', { cookie, body: { clientId: 'not-connected', days: 5 } })).status, 404);
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
  // Past a hundred revoked tokens the live one is still found, by the engine's standing check as by the list.
  const { credentialStands } = await import('../credential-standing.mjs');
  const user = (await (await auth.$context).internalAdapter.findUserByEmail('idle@example.test')).user;
  assert.equal(await credentialStands(auth, settings.credential_standing, `mcp-access:${user.id}:${client}`), true);
});

test('an AI unused past the person\'s limit has lost access: the refresh is refused and the list says so, with when, last use and where to reconnect', async () => {
  const client = await newClient('Idle AI', 'https://idle-ai.example.test/connect');
  const token = await connect(client);
  await limit(client, 30);
  const usedAt = (await listed(client)).last_used_at;
  await older(client, 31);
  assert.equal((await refresh(client, token.refresh_token)).status, 400);
  const ai = await listed(client);
  assert.equal(ai.ended_by, 'unused');
  assert.equal(ai.ended_text, 'Access ended: not used for 30 days.');
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
    await limit(client, 30);
    await older(client, 31);
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
  await limit(ended, 30);
  await older(ended, 31);
  assert.equal((await call('/connected/revoke', { cookie, body: { clientId: ended } })).status, 200);
  assert.equal(await listed(ended), undefined, 'one tap clears an ended AI from the list');
});

test('a grant stands while it holds a token not revoked and not ended; past the person\'s limit, revoked, chain-ended or banned it does not', async () => {
  const { credentialStands } = await import('../credential-standing.mjs');
  const stands = grant => credentialStands(auth, settings.credential_standing, grant);
  const userId = (await pool.query('select id from "user" where email = $1', ['idle@example.test'])).rows[0].id;

  const idle = await newClient('Limited standing AI');
  await connect(idle);
  assert.equal(await stands(`mcp-access:${userId}:${idle}`), true, 'no limit: it stands');
  await older(idle, 400);
  assert.equal(await stands(`mcp-access:${userId}:${idle}`), true, 'no end by default, even after 400 days unused');
  await limit(idle, 30);
  assert.equal(await stands(`mcp-access:${userId}:${idle}`), false, 'past the person\'s limit it does not stand');
  assert.equal((await listed(idle)).ended_by, 'unused');
  assert.equal((await call('/connected/revoke', { cookie, body: { clientId: idle } })).status, 200);
  assert.equal(await listed(idle), undefined);

  const revoked = await newClient('Revoked scheduled AI');
  await connect(revoked);
  await limit(revoked, 30);
  await older(revoked, 31);
  await call('/connected/revoke', { cookie, body: { clientId: revoked } });
  assert.equal(await stands(`mcp-access:${userId}:${revoked}`), false, 'revoked');

  const reused = await newClient('Reused scheduled AI');
  const first = await connect(reused);
  await refresh(reused, first.refresh_token);
  await pool.query('update "oauthRefreshToken" set "rotationReplayExpiresAt" = now() - interval \'1 second\' where "clientId" = $1 and "rotatedAt" is not null', [reused]);
  await refresh(reused, first.refresh_token);
  await older(reused, 31);
  assert.equal(await stands(`mcp-access:${userId}:${reused}`), false, 'chain ended');

  const banned = await newClient('Banned scheduled AI');
  await connect(banned);
  await limit(banned, 30);
  await older(banned, 31);
  await pool.query('update "user" set banned = true where id = $1', [userId]);
  assert.equal(await stands(`mcp-access:${userId}:${banned}`), false, 'a banned person');
  await pool.query('update "user" set banned = false where id = $1', [userId]);
});

test('the same renewal sent again right after it answered is answered too and the sign-in lives on (settings.mcp.refresh_token_reuse_interval)', async () => {
  const client = await newClient('Retrying AI');
  const first = await connect(client);
  const answers = [await refresh(client, first.refresh_token), await refresh(client, first.refresh_token), await refresh(client, first.refresh_token)];
  assert.deepEqual(answers.map(answer => answer.status), [200, 200, 200], 'a duplicate inside the window is not taken for theft');
  const newest = await answers[2].json();
  assert.equal((await refresh(client, newest.refresh_token)).status, 200, 'the chain is alive: the newest token renews');
  assert.ok(settings.mcp.refresh_token_reuse_interval > 0 && settings.mcp._refresh_token_reuse_interval_why);
});
