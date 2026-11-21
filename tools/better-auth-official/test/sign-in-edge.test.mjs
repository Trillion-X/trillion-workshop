// tools/better-auth-official/test/sign-in-edge.test.mjs
//
// The sign-in edge cases the old product handled and the pages once did not (r6-sign-in-edge-cases.md rows 3, 4, 7, 16, 24, 10): a
// message that did not go says so, a code's life and tries are what the pages say, an address nobody proved cannot be taken
// with a password, a person who signed in without a password can add one, a one-time link adds a passkey on another device and
// lives a day, and a person changes their address.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageAnswer } from '../pages.mjs';
import { startStore } from '../test-fixtures/embedded-store.mjs';
import { startStandInSender } from '../test-fixtures/stand-in-sender.mjs';
import emailWords from '../email-words.json' with { type: 'json' };

const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { getMigrations } = await import('better-auth/db/migration');
const store = await startStore();
const sender = await startStandInSender();
const refusing = await startStandInSender({ refuse: true });
process.env.CREDENTIALS_DIRECTORY = sender.credentials;
test.after(() => { store.stop(); sender.stop(); refusing.stop(); });
let made = 0;
let caller = 0; // each request comes from its own address, because the rate limit is kept per address for the whole process

// A scratch Better Auth on the shipped settings and what a test changes, sending its mail to the stand-in sender.
async function scratch(overrides = {}) {
  const dir = tempFolder(join(tmpdir(), 'sign-in-edge-'));
  const settings = { ...shipped, disabled_paths: [], email: sender.email, ...overrides };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  process.env.BETTER_AUTH_SETTINGS = join(dir, 'settings.json');
  process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
  const { auth, pool } = await import(`../auth.mjs?scratch-${made++}`);
  store.hold(pool);
  await (await getMigrations(auth.options)).runMigrations();
  const origin = settings.base_url;
  const call = (path, { body, cookie, from = `198.51.100.${(caller++ % 250) + 1}` } = {}) => auth.handler(new Request(`${origin}${settings.base_path}${path}`, {
    method: body ? 'POST' : 'GET', headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': from, ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body),
  }));
  const mail = sender.mail;
  const cookieOf = response => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  // Sign in by email code: asks for the code, reads it from the mail the sender accepted, and answers with it.
  const signInByCode = async (email, from) => {
    const sent = await call('/email-otp/send-verification-otp', { body: { email, type: 'sign-in' }, from });
    if (sent.status !== 200) throw new Error(`send ${sent.status} ${await sent.text()}`);
    const code = mail().filter(row => row.to === email && row.otp).at(-1).otp;
    return call('/sign-in/email-otp', { body: { email, otp: code }, from });
  };
  return { auth, settings, call, mail, cookieOf, signInByCode, dir };
}

test('a code that could not be sent is an error, never "on its way"; one that was sent is an answer 200', async () => {
  const broken = await scratch({ email: refusing.email });
  const failed = await broken.call('/email-otp/send-verification-otp', { body: { email: 'nobody@example.test', type: 'sign-in' } });
  assert.notEqual(failed.status, 200);
  assert.equal((await failed.json()).code, 'EMAIL_NOT_SENT', 'the page says the code was not sent');
  const working = await scratch();
  assert.equal((await working.call('/email-otp/send-verification-otp', { body: { email: 'somebody@example.test', type: 'sign-in' } })).status, 200);
  const sent = working.mail().at(-1);
  assert.deepEqual([sent.from, sent.to], [sender.email.from, 'somebody@example.test'], 'the sender gets the from address and the person');
  assert.equal(sent.otp.length, working.settings.email_code.digits);
  assert.match(sent.subject, new RegExp(sent.otp));
  assert.match(sent.text, new RegExp(`for ${working.settings.email_code.expires_in_seconds / 60} minutes`), 'the email says the same minutes as the page');
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
  // Nov 21 2026: testers at one home address filled its bucket and the owner's phone, on the same Wi-Fi, was refused. The cap is per
  // address and email, so another person at the same address still gets a code; the address alone has its own, larger cap.
  const other = await call('/email-otp/send-verification-otp', { body: { email: 'neighbour@example.test', type: 'sign-in' }, from: '203.0.113.7' });
  assert.equal(other.status, 200, 'another email at the same address is not held by the first one\'s sends');
  const behind = await call('/email-otp/send-verification-otp', { body: { email: 'Capped@Example.test ', type: 'sign-in' }, from: '203.0.113.7, 127.0.0.1' });
  assert.equal(behind.status, 429, 'the same email written another way, behind the front door, is the same person');
  const total = [];
  for (let n = 0; n < settings.email_code.sends_per_address_per_window + 1; n++) total.push((await call('/email-otp/send-verification-otp', { body: { email: `many-${n}@example.test`, type: 'sign-in' }, from: '203.0.113.9' })).status);
  assert.equal(total.at(-1), 429, 'one address sending to many emails meets the address cap');
  assert.ok(total.slice(0, -1).every(status => status === 200), 'every send under the address cap goes');
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

test('the add-a-passkey link goes by email, is one-time, and lives a day', async () => {
  const { call, mail, auth, settings } = await scratch();
  const email = 'other-device@example.test';
  assert.equal((await call('/sign-in/magic-link', { body: { email, callbackURL: '/sign-in/add-passkey' } })).status, 200);
  const sent = mail().at(-1);
  assert.equal(sent.subject, emailWords.kinds['magic-link'].subject.replace('{name}', settings.site.name));
  assert.match(sent.text, /add-passkey/);
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
  assert.ok(mail().some(row => ['change-email', 'verify-email'].map(kind => emailWords.kinds[kind].subject.replace('{name}', settings.site.name)).includes(row.subject)), 'a link goes out');
  assert.equal((await auth.$context).sessionConfig.freshAge, settings.session.fresh_age_seconds);
});

test('the passkey words say how each step ended, and a device that already holds a passkey is done', () => {
  const words = JSON.parse(readFileSync(new URL('../pages/words.json', import.meta.url), 'utf8'));
  assert.equal(words.passkey_errors.make.ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED.already, true);
  assert.ok(words.passkey_errors['sign-in'].AUTH_CANCELLED.said.includes('Nothing changed'));
  assert.ok(words.alert_actions['email-code'], 'the action that follows is a button, named once');
  for (const rows of Object.values(words.passkey_errors)) for (const row of Object.values(rows)) assert.ok(row.said && ['done', 'cancelled', 'error'].includes(row.kind));
});
