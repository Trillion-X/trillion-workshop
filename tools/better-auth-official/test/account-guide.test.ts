// tools/better-auth-official/test/account-guide.test.ts
//
// The account screen's description (web/account-guide.ts): name and email with links to the sign-in pages that change them;
// every way of signing in with its real state; passkeys with Remove asked in place, or an empty part with Add a passkey;
// this device first and marked, the others each with Sign out and one Sign out everywhere else; a sign-in too old to list
// sessions says how to see them; delete asks in place, with a secret password box when the account has a password; a
// refused change is said under its own part; and a session token is never drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_ACTIONS, accountGuide, deviceName, screenWords as S, signInWords as W, type AccountGuideInput } from '../web/account-guide.ts';

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const BASE: AccountGuideInput = {
  user: { name: 'Sam', email: 'sam@example.com', emailVerified: true, twoFactorEnabled: false },
  accounts: [{ providerId: 'google' }],
  passkeys: [],
  sessions: [
    { token: 'tok-other', userAgent: IPHONE, updatedAt: '2026-11-20T12:00:00Z' },
    { token: 'tok-mine', userAgent: MAC_CHROME, updatedAt: '2026-11-24T12:00:00Z' },
    { token: 'tok-third', userAgent: 'curl/8', updatedAt: '2026-11-10T12:00:00Z' },
  ],
  currentToken: 'tok-mine',
  here: '/',
};
const section = (input: AccountGuideInput, id: string) => accountGuide(input).sections.find(part => part.id === id);

test('name and email, each with a link to the sign-in page that changes it, and the email marked verified', () => {
  const rows = section(BASE, 'profile')?.rows ?? [];
  assert.deepEqual(rows.map(row => [row.title, row.detail, row.actions?.[0].href]), [[W.account_name, 'Sam', '/sign-in/your-name'], [W.account_email, 'sam@example.com', '/sign-in/change-email']]);
  assert.deepEqual(rows[1].status, { label: S.verified, tone: 'good' });
  assert.equal(section({ ...BASE, user: { ...BASE.user, name: ' ' } }, 'profile')?.rows?.[0].detail, W.account_name_unset);
});

test('every way of signing in with its real state, and each other account connected by name', () => {
  const rows = section(BASE, 'ways')?.rows ?? [];
  assert.deepEqual(rows.map(row => [row.id, row.status?.label]), [['email-code', S.on], ['password', S.off], ['authenticator', S.off], ['account:google', S.connected]]);
  assert.equal(rows.find(row => row.id === 'account:google')?.title, 'Google');
  const withPassword = section({ ...BASE, accounts: [{ providerId: 'credential' }] }, 'ways')?.rows ?? [];
  assert.equal(withPassword.find(row => row.id === 'password')?.status?.label, S.on);
  assert.equal(withPassword.find(row => row.id === 'accounts')?.detail, W.account_other_none);
});

test('no passkey is an empty part with Add a passkey as its strong action; a passkey can be removed after a question', () => {
  const none = section(BASE, 'passkeys');
  assert.equal(none?.empty?.title, W.account_passkeys_none);
  assert.deepEqual(none?.actions?.[0], { label: W.account_add_passkey, tone: 'primary', href: '/sign-in/add-passkey' });
  const some = section({ ...BASE, passkeys: [{ id: 'pk1', name: 'iCloud Keychain', createdAt: '2026-11-01T12:00:00Z' }] }, 'passkeys');
  const row = some?.rows?.[0];
  assert.equal(row?.title, 'iCloud Keychain');
  assert.equal(row?.detail, 'Added Nov 1, 2026');
  assert.equal(row?.actions?.[0].send?.path, ACCOUNT_ACTIONS.removePasskey);
  assert.ok(row?.actions?.[0].send?.confirm);
  assert.equal(some?.actions?.[0].tone, 'quiet');
});

test('this device first and marked, the others by last use each with Sign out, and one Sign out everywhere else', () => {
  const part = section(BASE, 'sessions');
  const rows = part?.rows ?? [];
  assert.deepEqual(rows.map(row => row.title), ['Chrome on Mac', 'Safari on iPhone', S.unknown_device]);
  assert.deepEqual(rows[0].status, { label: S.this_device, tone: 'good' });
  assert.equal(rows[0].actions?.[0].href, '/sign-out');
  assert.deepEqual(rows[1].actions?.[0].send, { path: ACCOUNT_ACTIONS.endSession, body: { token: 'tok-other' } });
  assert.equal(part?.actions?.[0].send?.path, ACCOUNT_ACTIONS.endOtherSessions);
  assert.ok(!JSON.stringify(rows.map(row => ({ ...row, actions: undefined }))).includes('tok-'), 'a token is never drawn');
});

test('one other session needs no Sign out everywhere else', () => {
  assert.equal(section({ ...BASE, sessions: (BASE.sessions as []).slice(0, 2) }, 'sessions')?.actions, undefined);
});

test('a sign-in too old to list sessions says how to see them, and comes back here', () => {
  const rows = section({ ...BASE, sessions: 'not-fresh', here: '/?screen=account' }, 'sessions')?.rows ?? [];
  assert.equal(rows[0].title, W.account_sessions_confirm);
  assert.equal(rows[0].actions?.[0].href, '/sign-in?next=%2F%3Fscreen%3Daccount');
});

test('delete asks in place; with a password it opens a secret box and sends it', () => {
  const plain = section(BASE, 'delete');
  assert.equal(plain?.actions?.[0].tone, 'danger');
  assert.equal(plain?.actions?.[0].send?.path, ACCOUNT_ACTIONS.deleteAccount);
  assert.ok(plain?.actions?.[0].send?.confirm);
  const withPassword = section({ ...BASE, accounts: [{ providerId: 'credential' }] }, 'delete')?.rows?.[0];
  assert.equal(withPassword?.starts_open, true);
  assert.deepEqual(withPassword?.fields, [{ name: 'password', label: W.account_password, secret: true }]);
  assert.equal(withPassword?.actions?.[0].send?.with_fields, true);
});

test('a refused change is said under its own part only', () => {
  const guide = accountGuide({ ...BASE, problem: { section: 'delete', text: W.account_wrong_password } });
  assert.equal(guide.sections.find(part => part.id === 'delete')?.note, W.account_wrong_password);
  assert.equal(guide.sections.filter(part => part.note).length, 1);
});

test('a device is named from its user agent by the words file, or called a browser', () => {
  assert.equal(deviceName(MAC_CHROME), 'Chrome on Mac');
  assert.equal(deviceName(IPHONE), 'Safari on iPhone');
  assert.equal(deviceName(null), S.unknown_device);
});
