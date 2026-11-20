// Setting or changing a password: the strength the typing shows, the length limits (characters, not bytes), the order of
// the checks, a counted current-password try, the confirmed email, the other-account refusal before any write, and the
// browsers ended only when a change (not a first password) is saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSetPassword, decideSetPasswordPage, passwordProblemKey, passwordScore, passwordStrengthSaid, SET_PASSWORD,
} from '../read-data/verify-every-port-sign-in-set-password.mjs';

const GOOD = 'correct-horse-9';
const calls = () => ({ kept: [], ended: 0 });
const deps = (log, keepAnswer = 'kept') => ({
  keep: async password => { log.kept.push(password); return keepAnswer; },
  endOtherBrowsers: async () => { log.ended += 1; },
});
const firstSave = { fresh: true, email: 'ana@example.com', password: GOOD, again: GOOD, kept: false, emailConfirmed: true, emailHeldByOther: false };
const change = { ...firstSave, kept: true, attempt: { waitMinutes: null, ownRecord: true, currentRight: true } };

test('the strength words follow the score: short, fine, good, strong', () => {
  assert.equal(passwordScore('abc'), 0);
  assert.equal(passwordStrengthSaid('abc'), 'Use at least 8 characters.');
  assert.equal(passwordStrengthSaid('abcdefgh'), 'Fine. A longer password is stronger.');
  assert.equal(passwordStrengthSaid('abcdefgh1234'), 'Good.', 'long enough and two kinds of character');
  assert.equal(passwordStrengthSaid('Abcdefgh1234'), 'Strong.', 'long and three kinds of character');
});

test('length limits count characters: eight emoji pass the minimum, a 257 character one is too long', () => {
  assert.equal(passwordProblemKey('😀'.repeat(8)), null);
  assert.equal(passwordProblemKey('a'.repeat(7)), 'too_short');
  assert.equal(passwordProblemKey('a'.repeat(256)), null);
  assert.equal(passwordProblemKey('a'.repeat(257)), 'too_long');
  assert.equal(passwordProblemKey(undefined), 'too_short');
});

test('a stale sign-in is sent to sign in again, with the old words and status, before anything is read', async () => {
  const log = calls();
  assert.deepEqual(await decideSetPassword({ ...firstSave, fresh: false, ...deps(log) }), {
    error: 'For your safety, sign in again first. Opening sign-in…', sign_in_again: true, status: 403,
  });
  assert.deepEqual(log, calls());
});

test('a missing or wrong-shaped email, a short or long password and a mismatched repeat are refused with old words', async () => {
  const log = calls();
  assert.deepEqual(await decideSetPassword({ ...firstSave, email: null, ...deps(log) }), { error: 'Type the email address you sign in with.', status: 400 });
  assert.deepEqual(await decideSetPassword({ ...firstSave, password: 'short', again: 'short', ...deps(log) }), { error: 'Use at least 8 characters for your password.', status: 400 });
  assert.deepEqual(await decideSetPassword({ ...firstSave, password: 'a'.repeat(257), again: 'a'.repeat(257), ...deps(log) }), { error: 'Use at most 256 characters for your password.', status: 400 });
  assert.deepEqual(await decideSetPassword({ ...firstSave, again: 'different-one-9', ...deps(log) }), { error: 'The two new passwords are not the same. Type it again.', status: 400 });
  assert.deepEqual(log, calls(), 'nothing is kept on a refusal');
});

test('a change whose try is held back waits, with the forgot-password offer and 429', async () => {
  const log = calls();
  const held = await decideSetPassword({ ...change, attempt: { waitMinutes: 12, ownRecord: true, currentRight: true }, ...deps(log) });
  assert.deepEqual(held, {
    error: 'Too many tries. Wait 12 minutes, then try again, or choose Forgot password.', status: 429, next: { action: '/sign-in/forgot-password' },
  });
  assert.deepEqual(log, calls());
});

test('a wrong current password, or a record that is not this account\'s, is refused as current_wrong (400)', async () => {
  const log = calls();
  const wrong = { error: 'Your current password is not right. Type it again, or choose Forgot password.', status: 400, next: { action: '/sign-in/forgot-password' } };
  assert.deepEqual(await decideSetPassword({ ...change, attempt: { waitMinutes: null, ownRecord: true, currentRight: false }, ...deps(log) }), wrong);
  assert.deepEqual(await decideSetPassword({ ...change, attempt: { waitMinutes: null, ownRecord: false, currentRight: true }, ...deps(log) }), wrong);
  assert.deepEqual(log, calls());
});

test('an email that is not the account\'s confirmed one is refused (403) with the add-email step', async () => {
  const log = calls();
  assert.deepEqual(await decideSetPassword({ ...firstSave, emailConfirmed: false, ...deps(log) }), {
    error: 'Confirm this email on Account & security before using it to sign in.', status: 403, next: { action: '/sign-in/add-email' },
  });
  assert.deepEqual(log, calls());
});

test('an email another account signs in with is refused (409) before the password is kept', async () => {
  const log = calls();
  assert.deepEqual(await decideSetPassword({ ...firstSave, emailHeldByOther: true, ...deps(log) }), {
    error: 'Another account signs in with this email. Use a different email.', status: 409,
  });
  assert.deepEqual(log, calls());
});

test('a keep that comes back taken is refused (409) and ends no browsers', async () => {
  const log = calls();
  assert.deepEqual(await decideSetPassword({ ...change, ...deps(log, 'taken') }), {
    error: 'Another account signs in with this email. Use a different email.', status: 409,
  });
  assert.equal(log.ended, 0);
});

test('a first password is saved and ends no browsers; the reply says saved and goes to the account page', async () => {
  const log = calls();
  assert.deepEqual(await decideSetPassword({ ...firstSave, ...deps(log) }), { said: 'Your password is saved.', redirect: '/account' });
  assert.deepEqual(log.kept, [GOOD]);
  assert.equal(log.ended, 0);
});

test('a change is saved, ends the other browsers once, and goes where the return rule says', async () => {
  const log = calls();
  assert.deepEqual(await decideSetPassword({ ...change, returnTo: '/sign-in/add-email', ...deps(log) }), {
    said: 'Your password is changed.', redirect: '/sign-in/add-email',
  });
  assert.equal(log.ended, 1);
});

test('the set-password page sends a stale sign-in, a passed offer and an unconfirmed account elsewhere, and shows otherwise', () => {
  const base = { fresh: true, pathWithSearch: '/sign-in/set-password?next=%2Factivity', hasEmail: true, kept: false, email: 'ana@example.com' };
  assert.deepEqual(decideSetPasswordPage({ ...base, fresh: false }), { redirect: '/sign-in?again=1&next=%2Fsign-in%2Fset-password%3Fnext%3D%252Factivity' });
  assert.deepEqual(decideSetPasswordPage({ ...base, offeredPath: '/activity', offerWanted: false }), { redirect: '/activity' });
  assert.deepEqual(decideSetPasswordPage({ ...base, hasEmail: false }), { redirect: '/sign-in/add-email?next=%2Fsign-in%2Fset-password%3Fnext%3D%252Factivity' });
  assert.deepEqual(decideSetPasswordPage({ ...base, offeredPath: '/activity', offerWanted: true, kept: true }), {
    page: { changing: true, email: 'ana@example.com', offered: '/activity' },
  });
  assert.equal(SET_PASSWORD.min_length, 8);
});
