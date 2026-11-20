// tools/better-auth-official/test/teams.test.mjs
//
// Teams are Better Auth's own organization plugin (teams enabled); nothing of ours keeps a team or its members. A person makes an
// organization and a team in it, invites another person, who accepts, and puts them in the team; the pass that person signs
// (an AI's access token and the session's JWT) then carries the ids of their teams as the claim settings.teams names, and the pass signed
// after they are taken out of the team no longer does. A person in no team carries the claim empty.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'teams-'));
const settings = { ...JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')), email_password: { require_verification: false }, disabled_paths: [], email: { sender: null, from: null } };
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

const jane = await signUp('jane@example.test');
const jeff = await signUp('jeff@example.test');
const alone = await signUp('alone@example.test');

// An AI's connect to the end as `who`: its access token.
async function accessTokenOf(who, clientId) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid wake:* offline_access', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const asked = await call(`/oauth2/authorize?${query}`, { cookie: who.cookie });
  const location = asked.headers.get('location') ?? '';
  const answered = await ok(await call('/oauth2/consent', { cookie: who.cookie, body: { accept: true, oauth_query: signedQuery(new URL(location, ORIGIN).search) } }));
  const code = new URL(answered.url).searchParams.get('code');
  const token = await (await call('/oauth2/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: settings.mcp.resource } })).json();
  return token.access_token;
}
const aiOf = async (who) => (await ok(await call('/oauth2/create-client', { cookie: who.cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'Scratch AI' } }))).client_id;
const sessionJwt = async (who) => (await ok(await call('/token', { cookie: who.cookie }))).token;

test('a person in no team carries the claim empty, in the AI access token and in the session JWT', async () => {
  assert.deepEqual(claims(await accessTokenOf(alone, await aiOf(alone)))[CLAIM], []);
  assert.deepEqual(claims(await sessionJwt(alone))[CLAIM], []);
});

test('a team member carries the team id in every pass and, taken out of the team, in none signed after', async () => {
  const org = await ok(await call('/organization/create', { cookie: jane.cookie, body: { name: 'Janes people', slug: 'janes-people' } }));
  const team = await ok(await call('/organization/create-team', { cookie: jane.cookie, body: { name: 'Editors', organizationId: org.id } }));
  const invitation = await ok(await call('/organization/invite-member', { cookie: jane.cookie, body: { email: 'jeff@example.test', role: 'member', organizationId: org.id } }));
  await ok(await call('/organization/accept-invitation', { cookie: jeff.cookie, body: { invitationId: invitation.id } }));
  const jeffsAi = await aiOf(jeff);
  assert.deepEqual(claims(await accessTokenOf(jeff, jeffsAi))[CLAIM], [], 'in the organization but in no team yet');

  await ok(await call('/organization/add-team-member', { cookie: jane.cookie, body: { teamId: team.id, userId: jeff.user.id, organizationId: org.id } }));
  assert.deepEqual(claims(await accessTokenOf(jeff, jeffsAi))[CLAIM], [team.id]);
  assert.deepEqual(claims(await sessionJwt(jeff))[CLAIM], [team.id]);
  const janes = claims(await accessTokenOf(jane, await aiOf(jane)))[CLAIM];
  assert.ok(janes.length === 1 && !janes.includes(team.id), 'the plugin puts the maker of an organization in its default team, and not in the others');

  await ok(await call('/organization/remove-team-member', { cookie: jane.cookie, body: { teamId: team.id, userId: jeff.user.id, organizationId: org.id } }));
  assert.deepEqual(claims(await accessTokenOf(jeff, jeffsAi))[CLAIM], []);
  assert.deepEqual(claims(await sessionJwt(jeff))[CLAIM], []);
});

test('the claim carries at most settings.teams.most ids, the newest', async () => {
  const org = await ok(await call('/organization/create', { cookie: jane.cookie, body: { name: 'Many', slug: 'many' } }));
  const ids = [];
  for (let n = 0; n < settings.teams.most + 3; n++) {
    const team = await ok(await call('/organization/create-team', { cookie: jane.cookie, body: { name: `Team ${n}`, organizationId: org.id } }));
    await ok(await call('/organization/add-team-member', { cookie: jane.cookie, body: { teamId: team.id, userId: jane.user.id, organizationId: org.id } }));
    ids.push(team.id);
  }
  const carried = claims(await sessionJwt(jane))[CLAIM];
  assert.equal(carried.length, settings.teams.most);
  assert.ok(carried.includes(ids.at(-1)) && !carried.includes(ids[0]));
});

test('an AI access token lives settings.mcp.access_token_seconds, which is how long a removed member can still be admitted', async () => {
  const claimsOf = claims(await accessTokenOf(alone, await aiOf(alone)));
  assert.equal(claimsOf.exp - claimsOf.iat, settings.mcp.access_token_seconds);
});
