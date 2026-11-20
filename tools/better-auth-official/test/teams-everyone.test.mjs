// tools/better-auth-official/test/teams-everyone.test.mjs
//
// settings.teams.everyone: team ids every person this tool signs in carries, with no teamMember row, so a computer that grants
// one of them admits each person this sign-in vouches for. A person carries them in the AI access token and the session JWT,
// first and once, beside the teams they are in by row, and the whole claim still holds at most settings.teams.most ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';
import { teamClaim } from '../teams-claim.mjs';

const EVERYONE = 'everyone-this-sign-in-vouches-for';
const dir = mkdtempSync(join(tmpdir(), 'teams-everyone-'));
const base = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...base, teams: { ...base.teams, everyone: [EVERYONE] }, email_password: { require_verification: false }, disabled_paths: [], email: { sender: null, from: null } };
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

const ORIGIN = settings.base_url;
const REDIRECT = 'http://127.0.0.1:9/callback';
const CLAIM = settings.teams.claim;
let from = 0;
const call = (path, { body, cookie, form } = {}) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: body || form ? 'POST' : 'GET',
  headers: { origin: ORIGIN, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-forwarded-for': `198.51.100.${(from++ % 250) + 1}`, ...(cookie ? { cookie } : {}) },
  body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
}));
const signUp = async (email) => {
  const made = await call('/sign-up/email', { body: { email, password: 'scratch-password-123', name: email.split('@')[0] } });
  return { cookie: made.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), user: (await made.json()).user };
};
const ok = async (answer) => { assert.ok([200, 201].includes(answer.status), JSON.stringify(await answer.clone().json().catch(() => ({})))); return answer.json(); };
const claims = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

async function accessTokenOf(who, clientId) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid wake:* offline_access', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const asked = await call(`/oauth2/authorize?${query}`, { cookie: who.cookie });
  const answered = await ok(await call('/oauth2/consent', { cookie: who.cookie, body: { accept: true, oauth_query: signedQuery(new URL(asked.headers.get('location') ?? '', ORIGIN).search) } }));
  const code = new URL(answered.url).searchParams.get('code');
  return (await (await call('/oauth2/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: settings.mcp.resource } })).json()).access_token;
}
const aiOf = async (who) => (await ok(await call('/oauth2/create-client', { cookie: who.cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'Scratch AI' } }))).client_id;
const sessionJwt = async (who) => (await ok(await call('/token', { cookie: who.cookie }))).token;

test('a person in no team by row carries the everyone teams in the AI access token and in the session JWT', async () => {
  const alone = await signUp('alone@example.test');
  assert.deepEqual(claims(await accessTokenOf(alone, await aiOf(alone)))[CLAIM], [EVERYONE]);
  assert.deepEqual(claims(await sessionJwt(alone))[CLAIM], [EVERYONE]);
});

test('a team member carries the everyone teams first, then their own, and the everyone team once', async () => {
  const jane = await signUp('jane@example.test');
  const org = await ok(await call('/organization/create', { cookie: jane.cookie, body: { name: 'Janes people', slug: 'janes-people' } }));
  const team = await ok(await call('/organization/create-team', { cookie: jane.cookie, body: { name: 'Editors', organizationId: org.id } }));
  await ok(await call('/organization/add-team-member', { cookie: jane.cookie, body: { teamId: team.id, userId: jane.user.id, organizationId: org.id } }));
  const carried = claims(await sessionJwt(jane))[CLAIM];
  assert.equal(carried[0], EVERYONE);
  assert.ok(carried.includes(team.id));
  assert.equal(carried.filter(id => id === EVERYONE).length, 1);
});

test('the everyone teams count toward most, and a row naming an everyone team is not carried twice', async () => {
  const named = { claim: 'team_ids', most: 3, everyone: ['a', 'b'] };
  assert.deepEqual(await teamClaim(named, async () => ['b', 'x', 'y'], 'u'), { team_ids: ['a', 'b', 'x'] });
  assert.deepEqual(await teamClaim({ claim: 'team_ids', most: 3 }, async () => ['x'], 'u'), { team_ids: ['x'] });
});
