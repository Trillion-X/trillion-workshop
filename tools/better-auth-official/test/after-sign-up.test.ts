// tools/better-auth-official/test/after-sign-up.test.ts
//
// After a person's account is made, the business is told (settings.after_sign_up): a signed POST of {user_id, email, made_at,
// cookies} to a local address. Made with an email and password or with an email code, the call is the same and is made once;
// signing in again later makes none. Only the named cookies go, and none for an account an admin makes for someone else. The
// account stands when the business refuses, fails or cannot be reached. The signature is the one the Workshop's signed-call
// receiver checks under the signing rule "sign-in-tool-call". A non-local address, a missing secret or a bad cookie name is
// refused when the server starts.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startStore } from '../test-fixtures/embedded-store.mjs';
import { startStandInSender } from '../test-fixtures/stand-in-sender.mjs';
import { afterSignUpBody, afterSignUpHook, cookiesNamed } from '../after-sign-up.ts';
import { checkSignature, signingRuleNamed } from '../../notice-when-something-shows-up/do-work/mechanisms/signed-service-calls.mjs';

const KEY = 'scratch-after-sign-up-key-0123456789';
const sender = await startStandInSender();
test.after(() => sender.stop());
writeFileSync(join(sender.credentials, 'after-sign-up-secret'), `${KEY}\n`);
process.env.CREDENTIALS_DIRECTORY = sender.credentials;
const dir = tempFolder(join(tmpdir(), 'after-sign-up-'));

// The business, on this computer: what it was sent, and what it answers (set by each test).
type Received = { path: string | undefined; headers: IncomingHttpHeaders; body: string };
const received: Received[] = [];
let answer = 200;
const business = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    received.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(answer).end('{}');
  });
});
await new Promise<void>(listening => business.listen(0, '127.0.0.1', listening));
const businessUrl = `http://127.0.0.1:${(business.address() as { port: number }).port}/after-sign-up`;
test.after(() => { business.closeAllConnections(); business.close(); });

const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const withAfterSignUp = (after: Record<string, unknown>) => ({
  ...shipped, email: sender.email, email_password: { require_verification: false }, disabled_paths: [], rate_limit: { ...shipped.rate_limit, enabled: false },
  after_sign_up: { ...shipped.after_sign_up, ...after },
});
const settingsFile = join(dir, 'settings.json');
writeFileSync(settingsFile, JSON.stringify(withAfterSignUp({ url: businessUrl, secret: 'after-sign-up-secret', timeout_ms: 2000, carried_cookies: ['site_ref'] })));
process.env.BETTER_AUTH_SETTINGS = settingsFile;
const store = await startStore();
process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth, pool } = await import('../auth.mjs');
store.hold(pool);
test.after(() => store.stop());
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();

const ORIGIN = shipped.base_url;
const PASSWORD = 'scratch-password-123';
type Instance = { handler: (request: Request) => Promise<Response> };
const post = (instance: Instance, path: string, body: unknown, cookie?: string) => instance.handler(new Request(`${ORIGIN}${shipped.base_path}${path}`, {
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
}));
const signUp = (instance: Instance, email: string, cookie?: string) => post(instance, '/sign-up/email', { email, password: PASSWORD, name: 'Scratch' }, cookie);
const userOf = async (email: string) => (await (await auth.$context).internalAdapter.findUserByEmail(email))?.user ?? null;
const callsFor = (email: string) => received.filter(call => JSON.parse(call.body).email === email);
async function signInByCode(email: string, cookie?: string) {
  assert.equal((await post(auth, '/email-otp/send-verification-otp', { email, type: 'sign-in' }, cookie)).status, 200);
  const otp = sender.mail().filter((message: { to: string; otp?: string }) => message.to === email && message.otp).at(-1)?.otp;
  assert.ok(otp, 'a code was sent');
  return post(auth, '/sign-in/email-otp', { email, otp }, cookie);
}

test('an account made with an email and password tells the business once: who, when, and only the named cookie', async () => {
  answer = 200;
  const made = await signUp(auth, 'password@example.test', 'theme=dark; site_ref=FRIEND-7K3Q; session_hint=abc');
  assert.equal(made.status, 200);
  const user = (await made.json()).user;
  const calls = callsFor('password@example.test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/after-sign-up');
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body, { user_id: user.id, email: 'password@example.test', made_at: new Date(user.createdAt).toISOString(), cookies: { site_ref: 'FRIEND-7K3Q' } });
});

test('an account made by an email code is told the same way, and signing in again later tells nothing', async () => {
  answer = 200;
  assert.equal((await signInByCode('code@example.test', 'site_ref=FRIEND-CODE')).status, 200);
  const user = await userOf('code@example.test');
  assert.ok(user, 'the code made the account');
  assert.deepEqual(callsFor('code@example.test').map(call => JSON.parse(call.body)), [{ user_id: user.id, email: 'code@example.test', made_at: new Date(user.createdAt).toISOString(), cookies: { site_ref: 'FRIEND-CODE' } }]);
  assert.equal((await signInByCode('code@example.test', 'site_ref=SOMEONE-ELSE')).status, 200);
  assert.equal(callsFor('code@example.test').length, 1, 'a later sign-in is not a new account');
});

test('an account made with no named cookie is told with none', async () => {
  answer = 200;
  assert.equal((await signUp(auth, 'plain@example.test', 'theme=dark')).status, 200);
  assert.deepEqual(JSON.parse(callsFor('plain@example.test')[0].body).cookies, {});
  assert.equal((await signUp(auth, 'nocookie@example.test')).status, 200);
  assert.deepEqual(JSON.parse(callsFor('nocookie@example.test')[0].body).cookies, {});
});

test('the call is signed as the Workshop receiver checks it (signing rule sign-in-tool-call), and a changed body does not check', async () => {
  answer = 200;
  await signUp(auth, 'signed@example.test', 'site_ref=FRIEND-SIGN');
  const [call] = callsFor('signed@example.test');
  const timestamp = String(call.headers['x-sign-in-timestamp']);
  assert.match(timestamp, /^\d{10}$/);
  assert.equal(call.headers['x-sign-in-signature'], `sha256=${createHmac('sha256', KEY).update(`${timestamp}.${call.body}`).digest('hex')}`);
  const verify = signingRuleNamed('sign-in-tool-call');
  assert.ok(verify, 'the receiver knows the rule');
  const nowSeconds = Number(timestamp);
  assert.deepEqual(checkSignature({ verify, headers: call.headers, body: call.body, secret: KEY, nowSeconds }), { ok: true });
  assert.equal(checkSignature({ verify, headers: call.headers, body: call.body.replace('FRIEND-SIGN', 'FRIEND-FAKE'), secret: KEY, nowSeconds }).reason, 'signature-mismatch');
  assert.equal(checkSignature({ verify, headers: call.headers, body: call.body, secret: 'not-the-key', nowSeconds }).reason, 'signature-mismatch');
});

test('the account stands when the business refuses the call', async () => {
  answer = 500;
  const made = await signUp(auth, 'refused@example.test', 'site_ref=FRIEND-500');
  answer = 200;
  assert.equal(made.status, 200);
  assert.equal(callsFor('refused@example.test').length, 1, 'the business was asked');
  assert.ok(await userOf('refused@example.test'), 'the account stands');
});

test('the account stands when the business cannot be reached', async () => {
  const closed = createServer();
  await new Promise<void>(listening => closed.listen(0, '127.0.0.1', listening));
  const deadUrl = `http://127.0.0.1:${(closed.address() as { port: number }).port}/after-sign-up`;
  await new Promise(done => closed.close(done));
  const deadSettings = join(dir, 'settings-dead.json');
  writeFileSync(deadSettings, JSON.stringify(withAfterSignUp({ url: deadUrl, secret: 'after-sign-up-secret', timeout_ms: 1000, carried_cookies: ['site_ref'] })));
  process.env.BETTER_AUTH_SETTINGS = deadSettings;
  const { auth: dead, pool: deadPool } = await import('../auth.mjs?after-sign-up-dead');
  store.hold(deadPool);
  const made = await signUp(dead, 'unreachable@example.test', 'site_ref=FRIEND-DEAD');
  assert.equal(made.status, 200);
  assert.ok(await userOf('unreachable@example.test'), 'the account stands');
});

test('the cookie reader takes only the named cookies, once each, and leaves out an empty or overlong value', () => {
  assert.deepEqual(cookiesNamed('a=1; site_ref=X-1; site_ref=X-2; b=2', ['site_ref']), { site_ref: 'X-1' });
  assert.deepEqual(cookiesNamed(`site_ref=${'A'.repeat(257)}; other=1`, ['site_ref', 'other']), { other: '1' });
  assert.deepEqual(cookiesNamed('site_ref=; constructor=1', ['site_ref']), {});
  assert.deepEqual(cookiesNamed(null, ['site_ref']), {});
  assert.deepEqual(cookiesNamed('site_ref=X-1', []), {});
});

test('an account an admin makes for someone else carries no cookies, and no address tells nobody', () => {
  const user = { id: 'u1', email: 'made@example.test', createdAt: '2026-11-25T12:00:00.000Z' };
  const headers = new Headers({ cookie: 'site_ref=ADMIN-OWN' });
  assert.deepEqual(afterSignUpBody(user, { path: '/admin/create-user', headers }, ['site_ref']).cookies, {});
  assert.deepEqual(afterSignUpBody(user, { path: '/sign-up/email', headers }, ['site_ref']).cookies, { site_ref: 'ADMIN-OWN' });
  assert.equal(afterSignUpBody(user, null, ['site_ref']).made_at, '2026-11-25T12:00:00.000Z');
  assert.equal(afterSignUpHook({ url: null, secret: null, timeout_ms: 5000, carried_cookies: [] }), null);
  assert.equal(afterSignUpHook(undefined), null);
});

// A settings file is read when the server starts; each case starts the reader on its own, as a computer's start does.
function startsWith(after: Record<string, unknown>) {
  const file = join(dir, `start-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(withAfterSignUp(after)));
  const settingsModule = new URL('../settings.mjs', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import { readSettings } from '${settingsModule}'; readSettings();`], {
    env: { ...process.env, BETTER_AUTH_SETTINGS: file }, encoding: 'utf8',
  });
}

test('a non-local address, a missing secret, a bad cookie name or a bad wait is refused when the server starts', () => {
  const good = { url: 'http://127.0.0.1:9/after-sign-up', secret: 'after-sign-up-secret', timeout_ms: 5000, carried_cookies: ['site_ref'] };
  assert.equal(startsWith(good).status, 0);
  assert.equal(startsWith({ ...good, url: 'http://localhost:9/x' }).status, 0);
  assert.equal(startsWith({ url: null }).status, 0, 'no address: nothing to check');
  for (const url of ['http://example.test/x', 'https://127.0.0.1/x', 'http://10.0.0.5:9/x']) {
    const started = startsWith({ ...good, url });
    assert.notEqual(started.status, 0, url);
    assert.match(started.stderr, /after_sign_up\.url must be an http address on 127\.0\.0\.1 or localhost/, url);
  }
  assert.match(startsWith({ ...good, secret: null }).stderr, /needs after_sign_up\.secret/);
  assert.match(startsWith({ ...good, carried_cookies: ['bad name'] }).stderr, /carried_cookies must be a list of cookie names/);
  assert.match(startsWith({ ...good, carried_cookies: 'site_ref' }).stderr, /carried_cookies must be a list of cookie names/);
  assert.match(startsWith({ ...good, timeout_ms: 0 }).stderr, /timeout_ms must be a whole number/);
});
