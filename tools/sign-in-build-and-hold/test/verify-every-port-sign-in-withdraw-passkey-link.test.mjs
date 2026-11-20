// The one-time passkey link: a link works once, for its own account, within its lifetime; it is spent once its passkey checks
// out and before the passkey is saved; a passkey for another account is not saved; an unsaved passkey is named back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideBeginLinkUse, decideLinkSave, decideMakePasskeyLink, PASSKEY_LINK, refusedPasskeyAnswer,
} from '../read-data/verify-every-port-sign-in-withdraw-passkey-link.mjs';

const now = Date.parse('2026-11-20T12:00:00.000Z');
const NOT_SAVED = 'Your new passkey was not saved. Press "Add my passkey" again to make it.';

test('a made link lasts a day, is stored for the account, and is shown with its words', () => {
  const made = decideMakePasskeyLink({ fresh: true, userId: 'acct-7', code: 'c0de', origin: 'https://example.test', now });
  assert.deepEqual(made.store, { userId: 'acct-7', expires_at: '2026-11-21T12:00:00.000Z' });
  assert.equal(made.ttl_seconds, 86400);
  assert.deepEqual(made.reveal, {
    label: 'Open this link on the other device within a day. It adds one passkey there, then stops working.',
    text: 'https://example.test/account?add_passkey=c0de',
  });
  assert.equal(made.said, 'Send it to yourself, or scan it from the other device\'s camera app.');
});

test('a link is not made on a stale sign-in: the person is sent to sign in again first', () => {
  assert.deepEqual(decideMakePasskeyLink({ fresh: false, userId: 'acct-7', code: 'c0de', origin: 'https://example.test', now }), {
    said: 'For your safety, sign in again first. Opening sign-in…', redirect: '/sign-in?again=1&next=%2Faccount',
  });
});

test('a used, expired or made-up link is refused as used or expired (400) and gives the account to nobody', () => {
  assert.deepEqual(decideBeginLinkUse(null), { error: 'This link has already been used or has expired. Ask for a new one.', status: 400 });
  assert.deepEqual(decideBeginLinkUse({ userId: 'acct-7', expires_at: '2026-11-21T12:00:00.000Z' }), { mode: 'link', userId: 'acct-7' });
});

test('a link that is no longer held is refused with the not-saved words and spends nothing', () => {
  assert.deepEqual(decideLinkSave({ alive: false, verified: true, passkeyUserId: 'acct-7', linkUserId: 'acct-7' }), {
    spend: false, error: NOT_SAVED, status: 400,
  });
});

test('a passkey that does not verify is not saved, and the link is kept', () => {
  assert.deepEqual(decideLinkSave({ alive: true, verified: false, passkeyUserId: null, linkUserId: 'acct-7' }), {
    spend: false, error: NOT_SAVED, status: 400,
  });
});

test('a verified passkey for another account spends the link and saves nothing', () => {
  assert.deepEqual(decideLinkSave({ alive: true, verified: true, passkeyUserId: 'acct-9', linkUserId: 'acct-7' }), {
    spend: true, error: NOT_SAVED, status: 400,
  });
});

test('a verified passkey for the link\'s account is saved to it, and the link is spent first', () => {
  assert.deepEqual(decideLinkSave({ alive: true, verified: true, passkeyUserId: 'acct-7', linkUserId: 'acct-7' }), {
    spend: true, save: true, userId: 'acct-7',
  });
});

test('a made passkey that was not saved is named back to the device; a sign-in never is', () => {
  const answer = { error: NOT_SAVED };
  assert.deepEqual(refusedPasskeyAnswer({ mode: 'link', answer, responseId: 'cred-1', domain: 'example.test' }), {
    body: { error: NOT_SAVED, forget_passkey: { rp_id: 'example.test', credential_id: 'cred-1' } }, status: 400,
  });
  assert.deepEqual(refusedPasskeyAnswer({ mode: 'sign-in', answer, responseId: 'cred-1', domain: 'example.test' }).body, answer);
  assert.deepEqual(refusedPasskeyAnswer({ mode: 'link', answer, responseId: '', domain: 'example.test' }).body, answer);
});

test('the lifetime and statuses are the ones the earlier code gave', () => {
  assert.equal(PASSKEY_LINK.lifetime_seconds, 24 * 3600);
  assert.deepEqual(PASSKEY_LINK.statuses, { used_or_expired: 400, not_saved: 400 });
});
