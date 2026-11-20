// Known-passkey authority: a passkey gains authority from a moment fixed by how it was added; a recovery unknows the passkeys
// known before it started; any use of a known passkey cancels what waits and no known passkey confirmed; a change that
// destroys the account waits out the notice; notices are bounded per window; and passkeys saved before provenance are
// classified once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedNotice, authorityFor, authorityFrom, authorityView, cancelWaiting, delayedChangeDecision, hasAuthority, legacyAuthority,
  legacyNotice, linkForNotice, noticeRoom, notKnownWords, provenanceOf, recoverDecision, vouchDecision, withClassified,
} from '../read-data/known-passkey-authority.mjs';
import { changeKey } from '../../sign-in/read-data/guarded-change-confirm.mjs';

const HOUR = 3_600_000;
const now = Date.parse('2026-11-20T12:00:00Z');

test('how a passkey was added fixes its provenance: sign-up, vouched, notice, or unvouched', () => {
  assert.equal(provenanceOf({ mode: 'create' }), 'sign-up');
  assert.equal(provenanceOf({ mode: 'add', vouched: true, known: true }), 'known-passkey');
  assert.equal(provenanceOf({ mode: 'add', known: false }), 'notice', 'no known passkey yet: it waits out the notice');
  assert.equal(provenanceOf({ mode: 'add', known: true, recovering: true }), 'notice', 'during a recovery it waits out the notice');
  assert.equal(provenanceOf({ mode: 'add', known: true }), 'unvouched', 'an account with a known passkey never makes an unvouched one known');
});

test('a sign-up passkey is known at once; a notice or known-passkey one from its wait; an unvouched one never', () => {
  assert.equal(authorityFrom({ authority: authorityFor('sign-up', now) }), now);
  assert.equal(authorityFrom({ authority: authorityFor('notice', now) }), now + 72 * HOUR);
  assert.equal(authorityFrom({ authority: authorityFor('known-passkey', now) }), now + 72 * HOUR);
  assert.equal(authorityFrom({ authority: authorityFor('unvouched', now) }), null);
  assert.equal(authorityFrom({}), null, 'a record with no provenance is never known');
  assert.equal(authorityFor('notice', now, { notBefore: now + 100 * HOUR }).from, new Date(now + 100 * HOUR).toISOString(), 'held back until a recovery ends');
  assert.throws(() => authorityFor('nobody', now), /not a passkey provenance/);
});

test('a recovery that ran its wait unknows what was known before it started, and nothing else', () => {
  const before = { authority: authorityFor('sign-up', now - HOUR) };
  const during = { authority: authorityFor('notice', now) };
  const recovery = { started_at: new Date(now).toISOString(), from: new Date(now + 72 * HOUR).toISOString() };
  const afterRecovery = now + 73 * HOUR;
  assert.equal(hasAuthority(before, afterRecovery, recovery), false, 'known before the recovery started: unknown once it has run');
  assert.equal(hasAuthority(before, now + HOUR, recovery), true, 'the recovery has not run yet');
  assert.equal(hasAuthority({ authority: authorityFor('notice', now + HOUR) }, now + 80 * HOUR, recovery), true, 'a passkey that gains authority after the recovery started is known');
});

test('the state of an account\'s passkeys: known, waiting, and the recovery and delayed change waiting', () => {
  const passkeys = [
    { id: 'sign-up', saved: { authority: authorityFor('sign-up', now - HOUR) } },
    { id: 'added', saved: { authority: authorityFor('notice', now) } },
    { id: 'unvouched', saved: { authority: authorityFor('unvouched', now) } },
  ];
  const view = authorityView({ passkeys, now: now + HOUR });
  assert.deepEqual(view.known.map(row => row.id), ['sign-up']);
  assert.deepEqual(view.waiting.map(row => row.id), ['added']);
  assert.equal(notKnownWords(passkeys[1].saved), 'This passkey cannot confirm this change until ' + new Date(now + 72 * HOUR).toUTCString() + ': it was added without a confirmation from a passkey you already had. Use a passkey you had before, or wait until then.');
  assert.equal(notKnownWords(passkeys[2].saved), 'This passkey signs in, but it was added without a confirmation from a passkey you already had, so it cannot confirm changes. Vouch for it on Account & security with a passkey you had before.');
});

test('a known passkey\'s use cancels what waits that no known passkey confirmed, and ends a waiting recovery and delayed change', () => {
  const passkeys = [
    { id: 'added', saved: { authority: authorityFor('notice', now) } },
    { id: 'vouched', saved: { authority: authorityFor('known-passkey', now) } },
  ];
  const state = authorityView({ passkeys, recovery: { started_at: 'x', from: new Date(now + HOUR).toISOString() }, now });
  const cancelled = cancelWaiting({ state, now });
  assert.deepEqual(cancelled.cancelled, ['added'], 'a notice waiting passkey is cancelled');
  assert.equal(cancelled.updates[0].saved.authority.by, 'unvouched');
  assert.equal(cancelled.updates[0].saved.authority.cancelled.by, 'notice', 'the earlier provenance is kept as cancelled');
  assert.equal(cancelled.recovery_cancelled, true);
  assert.equal(cancelled.clear_delayed, true);
});

test('a passkey vouched for is told at once, and is known after its wait', () => {
  const row = { id: 'pk-2', saved: { userId: 'user-a' } };
  const vouch = vouchDecision({ row, now });
  assert.equal(vouch.saved.authority.by, 'known-passkey');
  assert.equal(vouch.notice.key, 'passkey-added:pk-2');
  assert.equal(vouch.notice.body, 'It signs in now. A passkey you already had confirmed adding it, so from ' + new Date(now + 72 * HOUR).toUTCString() + ' it can also confirm changes to your limits. If you did not add it, remove it on Account & security before then.');
  assert.equal(vouch.said, 'This passkey can confirm changes to your limits from ' + new Date(now + 72 * HOUR).toUTCString() + '. Everywhere you are told hears of it now.');
  assert.equal(addedNotice('sign-up-id', authorityFor('sign-up', now)), null, 'the sign-up passkey is not told');
  assert.equal(addedNotice('pk-3', authorityFor('unvouched', now)).body, 'It signs in, but it cannot confirm changes to your limits, since no passkey you had confirmed it. If you did not add it, remove it on Account & security.');
});

test('the notice room holds at most the most notices in the window, and the times it keeps are the ones in the window', () => {
  const window = 24 * HOUR;
  const times = [new Date(now - window - 1).toISOString(), new Date(now - 1000).toISOString(), new Date(now - 2000).toISOString(), new Date(now - 3000).toISOString()];
  const full = noticeRoom({ times, now });
  assert.equal(full.room, false, 'three told within the window');
  assert.equal(full.times.length, 3, 'the one outside the window is dropped');
  const room = noticeRoom({ times: times.slice(0, 1), now });
  assert.equal(room.room, true);
  assert.equal(room.times.at(-1), new Date(now).toISOString());
});

test('a change that deletes the account waits out the notice: first asked it starts, asked again early it is refused, asked again after it goes', () => {
  const change = { action: 'account/delete' };
  const started = delayedChangeDecision({ change, delayed: null, room: true, now });
  assert.equal(started.kind, 'started');
  assert.equal(started.row.change, changeKey(change));
  assert.equal(started.row.from, new Date(now + 72 * HOUR).toISOString());
  assert.match(started.notice.body, /^It goes ahead only if it is asked again after /);
  const early = delayedChangeDecision({ change, delayed: started.row, room: true, now: now + HOUR });
  assert.equal(early.kind, 'refused');
  assert.equal(early.status, 409);
  assert.match(early.error, /^This waits until .* Ask again after then to go ahead\.$/);
  const other = delayedChangeDecision({ change: { action: 'account/move', to: 'b' }, delayed: started.row, room: true, now: now + HOUR });
  assert.match(other.error, /^Another change that deletes or moves your account is waiting until /);
  assert.deepEqual(delayedChangeDecision({ change, delayed: started.row, room: true, now: started.row.from && Date.parse(started.row.from) }), { kind: 'go', clear: true });
  assert.equal(delayedChangeDecision({ change, delayed: null, room: false, now }).status, 429);
});

test('a recovery waits its notice; asked again while it waits it says so; with no known passkey it is not needed', () => {
  const started = recoverDecision({ known: 1, recovery: null, room: true, now });
  assert.equal(started.kind, 'started');
  assert.equal(started.row.from, new Date(now + 72 * HOUR).toISOString());
  assert.equal(recoverDecision({ known: 1, recovery: started.row, room: true, now }).kind, 'waiting');
  assert.equal(recoverDecision({ known: 0, recovery: null, room: true, now }).said, 'Your account has no passkey that confirms changes now, so a passkey you add waits out its notice without a recovery.');
  assert.equal(recoverDecision({ cancel: true, known: 1, recovery: started.row, room: true, now }).said, 'The recovery is cancelled.');
  assert.equal(recoverDecision({ known: 1, recovery: null, room: false, now }).status, 429);
});

test('passkeys saved before provenance are classified once: the sign-up one known, the others unvouched beside a known passkey', () => {
  const created = new Date(now - 10 * 60_000).toISOString();
  const legacy = [
    { id: 'first', saved: { created_at: created } },
    { id: 'later', saved: { created_at: new Date(now - HOUR).toISOString() } },
  ];
  const signUp = { method: 'passkey', at: new Date(now - 9 * 60_000).toISOString() };
  const decided = legacyAuthority({ legacy, known: false, signUp, now });
  assert.equal(decided.first.by, 'sign-up', 'saved within the sign-up window before the account was made');
  assert.equal(decided.first.from, created);
  assert.equal(decided.later.by, 'unvouched', 'beside a passkey that is known');
  const none = legacyAuthority({ legacy, known: false, signUp: null, now });
  assert.equal(none.first.by, 'notice', 'with no known passkey and no evidence, each waits out the notice');
  const rows = withClassified([{ id: 'first', saved: { created_at: created } }], decided);
  assert.equal(rows[0].saved.authority.by, 'sign-up');
  assert.match(legacyNotice('user-a', decided).body, /^Passkeys on your account saved before the service recorded how each was added \(1\) still sign you in, but they confirm changes only once/);
  assert.equal(legacyNotice('user-a', { first: decided.first }), null, 'only the sign-up passkey: nothing to tell');
  assert.equal(hasAuthority({ authority: decided.first }, now), true);
});

test('a link the operator makes is told until its time', () => {
  const notice = linkForNotice('user-a', new Date(now + HOUR).toISOString());
  assert.equal(notice.key, `passkey-link-for:user-a:${new Date(now + HOUR).toISOString()}`);
  assert.match(notice.body, /^Whoever opens it before /);
});
