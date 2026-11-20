// Removing a passkey: only the account's own passkeys go, the last one only while a password signs in, a stale sign-in is
// sent to sign in again, and the known-passkey authority's refusal is passed on unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePasskeyRemoval, PASSKEY_REMOVE, signInAgainAddress } from '../read-data/verify-every-port-sign-in-passkey-remove.mjs';

const base = {
  fresh: true, passkeyId: 'pk-1', passkeyIds: ['pk-1', 'pk-2'], passwordSet: false, saved: { userId: 'acct-7' }, sessionUserId: 'acct-7',
};

test('a passkey on the account goes when the sign-in is recent and the authority allows it', () => {
  assert.deepEqual(decidePasskeyRemoval(base), { remove: 'pk-1', said: 'The passkey is removed.', refresh: true });
});

test('an id that is not on the account list is refused as not on the account (404), with the old words', () => {
  assert.deepEqual(decidePasskeyRemoval({ ...base, passkeyId: 'pk-9' }), { error: 'That passkey is not on your account.', status: 404 });
  assert.deepEqual(decidePasskeyRemoval({ ...base, passkeyId: undefined }), { error: 'That passkey is not on your account.', status: 404 });
});

test('a stored passkey that belongs to another account is refused as not on the account', () => {
  assert.deepEqual(decidePasskeyRemoval({ ...base, saved: { userId: 'acct-8' } }), { error: 'That passkey is not on your account.', status: 404 });
});

test('the last passkey goes only while a password still signs in (409, old words)', () => {
  const last = { ...base, passkeyIds: ['pk-1'], passwordSet: false };
  assert.deepEqual(decidePasskeyRemoval(last), {
    error: 'This is your only way to sign in. Set a password or add another passkey before removing it.', status: 409,
  });
  assert.deepEqual(decidePasskeyRemoval({ ...last, passwordSet: true }), { remove: 'pk-1', said: 'The passkey is removed.', refresh: true });
});

test('with two or more passkeys a passkey may go even when no password signs in', () => {
  assert.equal(decidePasskeyRemoval({ ...base, passwordSet: false }).remove, 'pk-1');
});

test('a sign-in that is not recent is sent to sign in again before anything is removed', () => {
  assert.deepEqual(decidePasskeyRemoval({ ...base, fresh: false }), {
    said: 'For your safety, sign in again first. Opening sign-in…', redirect: '/sign-in?again=1&next=%2Faccount',
  });
  assert.equal(signInAgainAddress('/account'), '/sign-in?again=1&next=%2Faccount');
});

test('the known-passkey authority refusal is returned unchanged, and nothing is removed under it', () => {
  const refusal = { error: 'Confirm with a known passkey first.', status: 403, step_needed: 'confirm', change: { action: 'passkeys/remove', passkey_id: 'pk-1' } };
  assert.deepEqual(decidePasskeyRemoval({ ...base, authorityRefusal: refusal }), refusal);
});

test('the refusal statuses are the ones the old route gave', () => {
  assert.deepEqual(PASSKEY_REMOVE.statuses, { not_on_account: 404, only_way_in: 409 });
});
