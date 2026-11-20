// tools/better-auth-official/test/cimd-connect.test.mjs
//
// How an AI product (Claude, ChatGPT) really connects: its client_id is the https address of its client metadata document, no one
// registers it first, Better Auth reads the document, the person gives consent, and the AI trades the code for tokens. A refresh
// token comes only when the AI asked for offline_access AND its document lists the refresh_token grant; without it the person is
// signed out when the access token ends.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const standIn = new URL('../test-fixtures/cimd-stand-in.mjs', import.meta.url);
const dir = tempFolder(join(tmpdir(), 'cimd-connect-'));
const settings = { ...JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')), email_password: { require_verification: false }, disabled_paths: [], cimd: { fetch_module: standIn.href } };
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
const { documents } = await import(standIn.href);
const { signedQuery } = await import('../pages/oauth-query.mjs');

const ORIGIN = settings.base_url;
const REDIRECT = 'https://claude.example.test/api/mcp/auth_callback';
const handle = (path, init) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, init));
const post = (path, body, cookie) => handle(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const up = await post('/sign-up/email', { email: 'cimd@example.test', password: 'scratch-password-123', name: 'Scratch' });
const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

// The whole connect from the AI's side: authorize (the client id is a document address), consent, then the token request.
async function connect(clientId, scope) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const asked = await handle(`/oauth2/authorize?${query}`, { headers: { cookie } });
  let location = asked.headers.get('location') ?? '';
  if (location.startsWith(settings.mcp.consent_page)) {
    const answered = await (await post('/oauth2/consent', { accept: true, oauth_query: signedQuery(new URL(location, ORIGIN).search) }, cookie)).json();
    location = answered.url;
  }
  const code = new URL(location, ORIGIN).searchParams.get('code');
  assert.ok(code, `an authorization code, not ${location}`);
  const token = await handle('/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: settings.mcp.resource }) });
  return { token: await token.json(), clientId };
}
const document = (id, extra = {}) => ({ client_id: id, client_name: 'Claude', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra });

test('a client that is only a metadata document address registers itself, and the consent names it from its document', async () => {
  const id = 'https://claude.example.test/oauth/metadata-a.json';
  documents.set(id, document(id));
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, scope: 'openid wake:*', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const asked = await handle(`/oauth2/authorize?${query}`, { headers: { cookie } });
  assert.ok(asked.headers.get('location').startsWith(settings.mcp.consent_page), 'a new AI is asked about');
  assert.equal((await (await handle(`/oauth2/public-client?client_id=${encodeURIComponent(id)}`, { headers: { cookie } })).json()).client_name, 'Claude');
  const metadata = await (await auth.handler(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json();
  assert.equal(metadata.client_id_metadata_document_supported, true, 'discovery says an AI may use its document address');
});

test('an AI that asked for offline_access and lists the refresh_token grant gets a refresh token, and refreshing works', async () => {
  const id = 'https://claude.example.test/oauth/metadata-b.json';
  documents.set(id, document(id));
  const { token } = await connect(id, 'openid wake:* tools:* offline_access');
  assert.ok(token.refresh_token, `a refresh token: ${JSON.stringify(Object.keys(token))}`);
  const refreshed = await (await handle('/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, resource: settings.mcp.resource }) })).json();
  assert.ok(refreshed.access_token, JSON.stringify(refreshed));
});

test('an AI that did not ask for offline_access still gets a refresh token (the person stays connected), and says so on the consent page', async () => {
  const id = 'https://claude.example.test/oauth/metadata-c.json';
  documents.set(id, document(id));
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, scope: 'openid wake:* tools:*', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const consent = (await handle(`/oauth2/authorize?${query}`, { headers: { cookie } })).headers.get('location');
  assert.ok(new URL(consent, ORIGIN).searchParams.get('scope').split(' ').includes('offline_access'), 'the consent is asked for offline_access too');
  const { token } = await connect(id, 'openid wake:* tools:*');
  assert.ok(token.refresh_token, 'a refresh token');
  assert.match(token.scope, /wake:\*/);
});

test('the AI product\'s own document must name the address it is served from', async () => {
  const id = 'https://claude.example.test/oauth/metadata-e.json';
  documents.set(id, document('https://elsewhere.example.test/other.json'));
  const asked = await handle(`/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, scope: 'openid', state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: settings.mcp.resource })}`, { headers: { cookie } });
  assert.ok(!(asked.headers.get('location') ?? '').startsWith(settings.mcp.consent_page), 'a document that names another address registers nothing');
});
