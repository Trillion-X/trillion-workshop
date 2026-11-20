// tools/better-auth-official/test/web-link.test.mjs
//
// A signed-in app asks for a one-use web link (POST /web-link) and the browser that opens it (GET /web-link/open) is signed in as the same
// person, once. A used, expired or made-up link goes to the sign-in page and signs nobody in; the address it goes to is checked when the link
// is made. These are the assertions of old trillion-rust src/account/sign_in/sessions.rs (web_link_... test, 2b8b821a4 lines 454-482) and
// routes.rs (a_web_link_opened_on_the_sign_in_page..., 2107-2125), in the Better Auth tool's own shape.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'web-link-'));
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...shipped, email_password: { require_verification: false }, disabled_paths: [], rate_limit: { ...shipped.rate_limit, enabled: false } };
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

const ORIGIN = settings.base_url;
const API = `${ORIGIN}${settings.base_path}`;
const PASSWORD = 'scratch-password-123';
const sessionOf = response => response.headers.getSetCookie().map(line => line.split(';')[0]).find(pair => pair.includes('_session='));
const post = (path, body, token) => auth.handler(new Request(`${API}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}));
const signUp = async email => {
  const response = await post('/sign-up/email', { email, password: PASSWORD, name: 'Scratch Person' });
  assert.equal(response.status, 200, await response.clone().text());
};
const signIn = async email => (await post('/sign-in/email', { email, password: PASSWORD })).headers.get('set-auth-token');
const makeLink = (token, next) => post('/web-link', next === undefined ? {} : { next }, token);
const open = code => auth.handler(new Request(`${API}/web-link/open?code=${code}`, { redirect: 'manual' }));
const codeOf = link => new URL(link).searchParams.get('code');
const whoAmI = cookie => auth.handler(new Request(`${API}/get-session`, { headers: { cookie } }));

test('a link made by a signed-in person opens once, signs the browser in as that person, and goes to the checked next', async () => {
  await signUp('one@example.test');
  const token = await signIn('one@example.test');
  const made = await makeLink(token, '/sign-in/security');
  assert.equal(made.status, 200);
  const { link, expires_in } = await made.json();
  assert.equal(expires_in, shipped.web_link.expires_in_seconds, 'the lifetime is the settings value');
  const code = codeOf(link);
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.ok(!link.includes('one@example.test'), 'nothing in the link names the person');

  const opened = await open(code);
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), '/sign-in/security');
  const fresh = sessionOf(opened);
  assert.ok(fresh, 'the browser is handed a session cookie');
  const who = await (await whoAmI(fresh)).json();
  assert.equal(who?.user?.email, 'one@example.test', 'the session is the same person');

  const again = await open(code);
  assert.equal(again.headers.get('location'), '/sign-in', 'a used link goes to the sign-in page');
  assert.equal(sessionOf(again), undefined, 'and signs nobody in');
  assert.equal(new URL((await open('0'.repeat(64))).headers.get('location'), ORIGIN).pathname, '/sign-in', 'a made-up link goes to the sign-in page');
});

test('the address a link opens is decided when it is made, and only the hash of its code is stored', async () => {
  await signUp('two@example.test');
  const token = await signIn('two@example.test');
  const { link } = await (await makeLink(token, '//evil.example')).json();
  const opened = await open(codeOf(link));
  assert.equal(opened.headers.get('location'), '/', 'another host is never the destination');

  const { link: second } = await (await makeLink(token, '/a\nSet-Cookie: x')).json();
  assert.equal((await open(codeOf(second))).headers.get('location'), '/', 'a control character is never kept');

  const code = bytesToHex(randomBytes(32));
  assert.equal(await (await open(code)).headers.get('location'), '/sign-in', 'a code nobody made opens nothing');
});

test('an expired link opens nothing', async () => {
  await signUp('three@example.test');
  const token = await signIn('three@example.test');
  const { link } = await (await makeLink(token, '/')).json();
  const code = codeOf(link);
  // The stored row is kept under the BLAKE3 hash of the code; a row whose expiry has passed is what an old link looks like.
  const ctx = await auth.$context;
  await ctx.adapter.update({
    model: 'verification',
    where: [{ field: 'identifier', value: `web-link:${bytesToHex(blake3(new TextEncoder().encode(code)))}` }],
    update: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await open(code)).headers.get('location'), '/sign-in');
});
