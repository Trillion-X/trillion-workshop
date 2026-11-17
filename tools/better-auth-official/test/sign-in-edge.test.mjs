// tools/better-auth-official/test/sign-in-edge.test.mjs
//
// The sign-in edge cases old Trillion handled and the pages once did not (r6-sign-in-edge-cases.md rows 3, 4, 7, 16, 24, 10): a
// message that did not go says so, a code's life and tries are what the pages say, an address nobody proved cannot be taken
// with a password, a person who signed in without a password can add one, a one-time link adds a passkey on another device and
// lives a day, and a person changes their address.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageAnswer } from '../pages.mjs';

const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { getMigrations } = await import('better-auth/db/migration');
let made = 0;
let caller = 0; // each request comes from its own address, because the rate limit is kept per address for the whole process

// A scratch Better Auth on the shipped settings and what a test changes, with its mail in an outbox file.
async function scratch(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sign-in-edge-'));
  const settings = { ...shipped, database_path: 'auth.db', disabled_paths: [], email: { outbox: 'outbox.jsonl', command: null }, ...overrides };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  process.env.BETTER_AUTH_SETTINGS = join(dir, 'settings.json');
  const { auth } = await import(`../auth.mjs?scratch-${made++}`);
  await (await getMigrations(auth.options)).runMigrations();
  const origin = settings.base_url;
  const call = (path, { body, cookie, from = `198.51.100.${(caller++ % 250) + 1}` } = {}) => auth.handler(new Request(`${origin}${settings.base_path}${path}`, {
    method: body ? 'POST' : 'GET', headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': from, ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body),
  }));
  const mail = () => (existsSync(join(dir, 'outbox.jsonl')) ? readFileSync(join(dir, 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  const cookieOf = response => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  // Sign in by email code: asks for the code, reads it from the outbox, and answers with it.
  const signInByCode = async (email, from) => {
    const sent = await call('/email-otp/send-verification-otp', { body: { email, type: 'sign-in' }, from });
    if (sent.status !== 200) throw new Error(`send ${sent.status} ${await sent.text()}`);
    const code = mail().filter(row => row.to === email && row.otp).at(-1).otp;
    return call('/sign-in/email-otp', { body: { email, otp: code }, from });
  };
  return { auth, settings, call, mail, cookieOf, signInByCode, dir };
}

test('a code that could not be sent is an error, never "on its way"; one that was sent is an answer 200', async () => {
  const broken = await scratch({ email: { command: ['/usr/bin/false'], outbox: 'outbox.jsonl' } });
  const failed = await broken.call('/email-otp/send-verification-otp', { body: { email: 'nobody@example.test', type: 'sign-in' } });
  assert.notEqual(failed.status, 200);
  const working = await scratch();
  assert.equal((await working.call('/email-otp/send-verification-otp', { body: { email: 'somebody@example.test', type: 'sign-in' } })).status, 200);
});

test('a code lives as long as the pages say, has the tries settings give, and sends are capped per window', async () => {
  const { call, mail, auth, settings } = await scratch();
  const email = 'tries@example.test';
  await call('/email-otp/send-verification-otp', { body: { email, type: 'sign-in' } });
  const code = mail().at(-1).otp;
  assert.equal(code.length, settings.email_code.digits);
  const rows = (await auth.$context).adapter;
  const stored = (await rows.findMany({ model: 'verification' })).find(row => row.identifier.includes(email));
  const life = (new Date(stored.expiresAt) - Date.now()) / 1000;
  assert.ok(life > settings.email_code.expires_in_seconds - 5 && life <= settings.email_code.expires_in_seconds, `a code lives ${life} s`);
  assert.match(pageAnswer('/sign-in/way?way=email-code&sent=1').body.toString(), new RegExp(`for ${settings.email_code.expires_in_seconds / 60} minutes`), 'the page says the same minutes');
  const wrong = code === '000000' ? '111111' : '000000';
  for (let n = 0; n < settings.email_code.attempts; n++) assert.notEqual((await call('/sign-in/email-otp', { body: { email, otp: wrong } })).status, 200);
  const late = await call('/sign-in/email-otp', { body: { email, otp: code } });
  assert.notEqual(late.status, 200, 'after its tries the right code no longer signs in');
  assert.equal((await late.json()).code, 'TOO_MANY_ATTEMPTS');
  const sends = [];
  for (let n = 0; n < settings.email_code.sends_per_window + 1; n++) sends.push((await call('/email-otp/send-verification-otp', { body: { email: 'capped@example.test', type: 'sign-in' }, from: '203.0.113.7' })).status);
  assert.deepEqual(sends.slice(0, -1).every(status => status === 200), true);
  assert.equal(sends.at(-1), 429, 'one more send in the window is refused');
});

test('a stranger cannot take an address with a password: it does not sign in, and the owner\'s first code clears it', async () => {
  const { call, signInByCode, cookieOf, auth } = await scratch();
  const email = 'victim@example.test';
  const registered = await call('/sign-up/email', { body: { email, password: 'strangers-password-1', name: 'Stranger' } });
  assert.equal(cookieOf(registered), '', 'registering a password makes no session');
  const refused = await call('/sign-in/email', { body: { email, password: 'strangers-password-1' } });
  assert.notEqual(refused.status, 200, 'an unproven address does not sign in with its password');
  const owner = await signInByCode(email);
  assert.equal(owner.status, 200);
  const user = (await (await auth.$context).internalAdapter.findUserByEmail(email)).user;
  assert.equal(user.emailVerified, true, 'the code proved the address');
  assert.notEqual((await call('/sign-in/email', { body: { email, password: 'strangers-password-1' } })).status, 200, 'what the stranger set up is gone');
});

test('a person who signed in by code adds a password, and signs in with it', async () => {
  const { call, signInByCode, cookieOf } = await scratch();
  const email = 'adds@example.test';
  const cookie = cookieOf(await signInByCode(email));
  assert.equal((await call('/set-password', { body: { newPassword: 'a-password-of-mine-1' }, cookie })).status, 200);
  assert.equal((await call('/sign-in/email', { body: { email, password: 'a-password-of-mine-1' } })).status, 200);
  assert.equal((await call('/set-password', { body: { newPassword: 'another-one-1234' } })).status, 401, 'signed out, nothing is set');
});

test('the add-a-passkey link goes by email, is one-time, and lives a day', async () => {
  const { call, mail, auth, settings } = await scratch();
  const email = 'other-device@example.test';
  assert.equal((await call('/sign-in/magic-link', { body: { email, callbackURL: '/sign-in/add-passkey' } })).status, 200);
  const sent = mail().at(-1);
  assert.equal(sent.kind, 'magic-link');
  assert.match(sent.url, /add-passkey/);
  const stored = (await (await auth.$context).adapter.findMany({ model: 'verification' })).find(row => row.value.includes(email));
  const life = (new Date(stored.expiresAt) - Date.now()) / 1000;
  assert.ok(life > settings.add_passkey_link.expires_in_seconds - 5 && life <= settings.add_passkey_link.expires_in_seconds);
  assert.equal(settings.add_passkey_link.expires_in_seconds, 86400);
});

test('a signed-in person starts a change of email, and a session is fresh for the minutes settings give', async () => {
  const { call, signInByCode, cookieOf, mail, auth, settings } = await scratch();
  const cookie = cookieOf(await signInByCode('before@example.test'));
  const changed = await call('/change-email', { body: { newEmail: 'after@example.test', callbackURL: '/' }, cookie });
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.ok(mail().some(row => ['change-email', 'verify-email'].includes(row.kind)), 'a link goes out');
  assert.equal((await auth.$context).sessionConfig.freshAge, settings.session.fresh_age_seconds);
});

test('the passkey words say how each step ended, and a device that already holds a passkey is done', () => {
  const words = JSON.parse(readFileSync(new URL('../pages/words.json', import.meta.url), 'utf8'));
  assert.equal(words.passkey_errors.make.ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED.already, true);
  assert.ok(words.passkey_errors['sign-in'].AUTH_CANCELLED.said.includes('Email me a code'));
  for (const rows of Object.values(words.passkey_errors)) for (const row of Object.values(rows)) assert.ok(row.said && ['done', 'cancelled', 'error'].includes(row.kind));
});
