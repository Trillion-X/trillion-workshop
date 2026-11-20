// The browsers list: this browser first, then newest, with its day and device only, and ending one: gone first, a recent
// sign-in and the guarded-change answer for another browser, and this browser may always sign itself out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWords, decideEndSession, sessionRows, SESSIONS_LIST } from '../read-data/verify-every-port-sign-in-sessions-list.mjs';

const sessions = [
  { id: 'old', device: 'Safari on a Mac', created_at: '2026-11-01T09:00:00.000Z' },
  { id: 'new', device: null, created_at: '2026-11-19T18:30:00.000Z' },
  { id: 'here', device: 'Chrome on a phone', created_at: '2026-11-10T08:00:00.000Z' },
];

test('this browser is listed first, then the rest newest first, and only the day and device are shown', () => {
  const rows = sessionRows({ sessions, currentSignIn: 'session:here' });
  assert.deepEqual(rows.map(row => row.id), ['here', 'new', 'old']);
  assert.deepEqual(rows[0], { id: 'here', device: 'Chrome on a phone', signed_in_day: 'Nov 10, 2026', current: true });
  assert.equal(rows[1].device, null, 'a missing device is shown as null');
  assert.equal(rows.every(row => !('created_at' in row)), true, 'the exact time is not listed');
});

test('with no asking browser nothing is marked current and order is newest first', () => {
  const rows = sessionRows({ sessions });
  assert.deepEqual(rows.map(row => row.id), ['new', 'here', 'old']);
  assert.equal(rows.some(row => row.current), false);
});

test('a day is words, and not a date is no day', () => {
  assert.equal(dayWords('2026-11-20T00:00:00.000Z'), 'Nov 20, 2026');
  assert.equal(dayWords(undefined), null);
  assert.equal(dayWords('2026'), null);
});

test('ending a browser that is already gone is refused as gone (404), before the sign-in is checked', () => {
  assert.deepEqual(decideEndSession({ sessionId: 'old', currentSessionId: 'here', entryExists: false, fresh: false }), {
    error: 'That sign-in is already gone.', status: 404,
  });
});

test('this browser signing itself out needs no recent sign-in and no guarded-change answer', () => {
  assert.deepEqual(decideEndSession({ sessionId: 'here', currentSessionId: 'here', entryExists: true, fresh: false, wayInRefusal: { error: 'x' } }), {
    forget: 'here', said: 'That browser is signed out.', refresh: true,
  });
});

test('ending another browser needs a recent sign-in first', () => {
  assert.deepEqual(decideEndSession({ sessionId: 'old', currentSessionId: 'here', entryExists: true, fresh: false }), {
    said: 'For your safety, sign in again first. Opening sign-in…', redirect: '/sign-in?again=1&next=%2Faccount',
  });
});

test('ending another browser passes on the guarded-change refusal unchanged', () => {
  const refusal = { error: 'Confirm with a known passkey first.', status: 403, step_needed: 'confirm' };
  assert.deepEqual(decideEndSession({ sessionId: 'old', currentSessionId: 'here', entryExists: true, fresh: true, wayInRefusal: refusal }), refusal);
});

test('ending another browser with a recent sign-in and no refusal forgets it and says it is signed out', () => {
  assert.deepEqual(decideEndSession({ sessionId: 'old', currentSessionId: 'here', entryExists: true, fresh: true }), {
    forget: 'old', said: 'That browser is signed out.', refresh: true,
  });
  assert.equal(SESSIONS_LIST.statuses.gone, 404);
});
