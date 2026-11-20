// A guarded change goes ahead only with a known passkey's confirmation for exactly that change: the key of a change is the
// same whatever its key order; a confirmation is held for one sign-in and one change; the words say exactly what the touch
// approves; a change to the ways the person is told waits while anything waits; and removing a known passkey needs a
// confirmation for exactly that removal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountConfirmationMatches, changeKey, confirmationBy, confirmationEnds, confirmationRecord, confirmedNotice,
  confirmWords, guardedChangeRefusal, NOT_A_CHANGE, PASSKEY_CONFIRMATION, removalRefusal,
} from '../read-data/guarded-change-confirm.mjs';

const none = { known: [], pending: false };
const known = { known: ['pk-1'], pending: false };

test('the key of a change is the same whatever the order of its keys, and an empty key is left out', () => {
  assert.equal(changeKey({ action: 'cap', b: 2, a: { y: 1, x: [{ q: 1, p: undefined }] } }),
    changeKey({ a: { x: [{ p: undefined, q: 1 }], y: 1 }, action: 'cap', b: 2 }));
  assert.notEqual(changeKey({ action: 'cap', limit: 1 }), changeKey({ action: 'cap', limit: 2 }), 'a different change has a different key');
  assert.equal(changeKey(null), 'null');
});

test('the confirmation words fill from the change; a change no confirmation may be for has none', () => {
  assert.equal(confirmWords({ action: 'paid-ceiling', dollars: 250 }), 'Confirm with your passkey: set your paid ceiling to 250 dollars.');
  assert.equal(confirmWords({ action: 'account/move', to: 'Second account' }), 'Confirm with your passkey: move everything in this account into another account (Second account).');
  assert.equal(confirmWords({ action: 'account/move' }), 'Confirm with your passkey: move everything in this account into another account ().', 'a missing value is left blank, as before');
  assert.equal(confirmWords({ action: 'not-named' }), null);
  assert.equal(confirmWords(undefined), null);
  assert.equal(NOT_A_CHANGE, 'That is not a change a passkey confirms here.');
  assert.equal(PASSKEY_CONFIRMATION, 'passkey-confirmation');
});

test('a confirmation is held for one sign-in and one exact change, and it is found only for both', () => {
  const change = { action: 'email/remove' };
  const held = confirmationRecord({ signIn: 'session:a', change, by: { passkey: 'pk-1', known_from: 7 } });
  assert.deepEqual(confirmationBy(held, { signIn: 'session:a', change }), { passkey: 'pk-1', known_from: 7 });
  assert.equal(confirmationBy(held, { signIn: 'session:b', change }), null, 'another sign-in');
  assert.equal(confirmationBy(held, { signIn: 'session:a', change: { action: 'password/remove' } }), null, 'another change');
  assert.equal(confirmationBy(null, { signIn: 'session:a', change }), null, 'nothing held');
  assert.equal(confirmationEnds(1000), 1000 + 120_000, 'a confirmation waits 120 seconds to be used');
});

test('a confirmation made in another account is found only for that account and that change', () => {
  const change = { action: 'account/move', to: 'b' };
  const held = confirmationRecord({ signIn: 'session:x', change, userId: 'user-a' });
  assert.equal(accountConfirmationMatches(held, { userId: 'user-a', change }), true);
  assert.equal(accountConfirmationMatches(held, { userId: 'user-b', change }), false);
  assert.equal(accountConfirmationMatches(held, { userId: 'user-a', change: { action: 'account/move', to: 'c' } }), false);
});

test('a change to the ways the person is told is held while anything waits, before any confirmation is looked at', () => {
  const refusal = guardedChangeRefusal({ state: { known: ['pk-1'], pending: true }, change: { action: 'email/remove' }, confirmed: true, channel: true });
  assert.equal(refusal.status, 409);
  assert.match(refusal.error, /^A new passkey or a passkey recovery is waiting/);
  assert.equal(guardedChangeRefusal({ state: { known: ['pk-1'], pending: true }, change: { action: 'cap' }, confirmed: false }).status, 403,
    'a change that is not a channel change is judged by its confirmation alone');
});

test('with no known passkey the change goes; with one it needs a confirmation for exactly that change', () => {
  assert.equal(guardedChangeRefusal({ state: none, change: { action: 'account/delete' }, confirmed: false }), null);
  const change = { action: 'cap', limit_id: 'l1' };
  const refused = guardedChangeRefusal({ state: known, change, confirmed: false });
  assert.deepEqual(refused, {
    error: 'This change needs your passkey: confirm it with a passkey you already had.',
    status: 403,
    step_needed: 'passkey-confirmation',
    change,
  });
  assert.equal(guardedChangeRefusal({ state: known, change, confirmed: true }), null);
});

test('removing a known passkey needs a confirmation for that removal; a passkey that is not known needs none', () => {
  assert.equal(removalRefusal({ state: known, id: 'pk-2', confirmed: false }), null, 'not a known passkey');
  const refused = removalRefusal({ state: known, id: 'pk-1', confirmed: false });
  assert.equal(refused.change.action, 'passkeys/remove');
  assert.equal(refused.change.passkey_id, 'pk-1');
  assert.equal(removalRefusal({ state: known, id: 'pk-1', confirmed: true }), null);
});

test('the confirmed notice says what was approved, in the words of that change', () => {
  const notice = confirmedNotice({ action: 'paid-ceiling', dollars: 40 });
  assert.equal(notice.title, 'Your passkey confirmed a change on your account');
  assert.match(notice.body, /^Confirm with your passkey: set your paid ceiling to 40 dollars\. If you did not do this/);
  assert.match(confirmedNotice({ action: 'unnamed' }).body, /^ If you did not do this/, 'no words for an unnamed change');
});
