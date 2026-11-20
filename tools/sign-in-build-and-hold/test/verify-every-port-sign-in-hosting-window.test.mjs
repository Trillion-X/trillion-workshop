// The hosting app's window is a session row of one account: a start keeps a live row and makes one otherwise; a removed,
// expired or other account's row is not live; a live row slides after a day without renewal and not before; an account
// with no session length does not slide a row and cannot start a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiry, RENEW_AFTER_MS, renewIfDue, startWindow, WINDOW_METHOD, windowLive } from '../read-data/verify-every-port-sign-in-hosting-window.mjs';

const DAY = 86_400_000;
const SESSION = 1_209_600; // two weeks, in seconds
const t0 = Date.parse('2026-11-20T12:00:00Z');

test('a window starts as a row for its account, with the account\'s session length and the window method', () => {
  const started = startWindow({ row: null, account: 'acct-a', id: 'hash-1', now: t0, sessionSeconds: SESSION });
  assert.equal(started.keep, false);
  assert.deepEqual(started.row, {
    id: 'hash-1', account: 'acct-a', expires_at: t0 + SESSION * 1000,
    value: { method: 'window', created_at: t0, renewed_at: t0 },
  });
  assert.equal(WINDOW_METHOD, 'window');
});

test('a second start keeps a live row as it is, and a new start replaces an expired one', () => {
  const first = startWindow({ row: null, account: 'acct-a', id: 'hash-1', now: t0, sessionSeconds: SESSION }).row;
  const again = startWindow({ row: first, account: 'acct-a', id: 'hash-1', now: t0 + 1000, sessionSeconds: SESSION });
  assert.equal(again.keep, true);
  assert.equal(again.row.value.created_at, t0, 'the live row keeps its creation time');
  const afterEnd = t0 + SESSION * 1000 + 1;
  const replaced = startWindow({ row: first, account: 'acct-a', id: 'hash-1', now: afterEnd, sessionSeconds: SESSION });
  assert.equal(replaced.keep, false);
  assert.equal(replaced.row.value.created_at, afterEnd, 'an expired row is replaced by a new one');
});

test('a removed row, an expired row and another account\'s row are not this window\'s', () => {
  const row = startWindow({ row: null, account: 'acct-a', id: 'hash-1', now: t0, sessionSeconds: SESSION }).row;
  assert.equal(windowLive({ row: null, account: 'acct-a', now: t0, sessionSeconds: SESSION }).live, false, 'no row before a start');
  assert.equal(windowLive({ row, account: 'acct-b', now: t0, sessionSeconds: SESSION }).live, false, 'another account');
  assert.equal(windowLive({ row, account: 'acct-a', now: t0, sessionSeconds: SESSION }).live, true);
  assert.equal(windowLive({ row, account: 'acct-a', now: row.expires_at, sessionSeconds: SESSION }).live, false, 'at the expiry it has ended');
});

test('a live row slides once it was last renewed more than a day ago, and not before', () => {
  const row = startWindow({ row: null, account: 'acct-a', id: 'hash-1', now: t0, sessionSeconds: SESSION }).row;
  assert.equal(RENEW_AFTER_MS, DAY);
  const soon = renewIfDue(row, t0 + DAY, SESSION);
  assert.equal(soon, row, 'exactly a day is not yet due');
  const later = t0 + DAY + 1;
  const slid = renewIfDue(row, later, SESSION);
  assert.equal(slid.value.renewed_at, later);
  assert.equal(slid.expires_at, expiry(later, SESSION));
  assert.equal(slid.value.created_at, t0, 'sliding keeps the creation time');
  assert.equal(row.value.renewed_at, t0, 'the row it slid from is not changed');
});

test('a stale live row is kept live and slid by the check that found it', () => {
  const row = startWindow({ row: null, account: 'acct-a', id: 'hash-1', now: t0, sessionSeconds: SESSION }).row;
  const later = t0 + 2 * DAY;
  const check = windowLive({ row, account: 'acct-a', now: later, sessionSeconds: SESSION });
  assert.equal(check.live, true);
  assert.equal(check.row.value.renewed_at, later);
});

test('an account with no session length does not slide a row, and cannot start a window', () => {
  const row = startWindow({ row: null, account: 'acct-a', id: 'hash-1', now: t0, sessionSeconds: SESSION }).row;
  const stale = t0 + 3 * DAY;
  assert.equal(renewIfDue(row, stale, null), row, 'the expiry stays as it is');
  assert.throws(() => startWindow({ row: null, account: 'acct-a', id: 'hash-1', now: t0, sessionSeconds: null }), /no session length/);
});
