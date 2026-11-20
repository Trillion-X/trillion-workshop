// Listing and turning off personal keys: a list never shows a key's value, shows only the caller's reach, newest first and
// at most the list maximum; an expiry is never later than the sign-in that sets it; a key is turned off only for its own
// account or by holding it, and never by a caller that reaches less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endedWords, endKeyDecision, expiredWords, expiryFrom, expiryOfChoice, isKeyId, keyExpired, keyRow, lastsWithin,
  manages, PERSONAL_KEYS, personalKeysPage,
} from '../read-data/keys-list-turn-off.mjs';

// A reach is a list of scopes; null is the full reach. `within(inner, outer)` is the reach owner's test for these tests.
const within = (inner, outer) => outer === null || (inner !== null && inner.every(scope => outer.includes(scope)));
const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const now = Date.parse('2026-11-20T12:00:00Z');

test('a key row names only its fields: never the key value, and it says when the key has expired', () => {
  const row = keyRow({ id: ID, name: 'Backup script', ending: 'f3a9', created_at: '2026-11-01T00:00:00.000Z', expires_at: '2026-11-19T00:00:00.000Z', secret: 'nm_should_not_appear' }, now);
  assert.deepEqual(Object.keys(row).sort(), ['ceiling', 'created_at', 'ending', 'expires_at', 'expired', 'id', 'last_used_at', 'name', 'purpose', 'reach'].sort());
  assert.equal(row.expired, true);
  assert.equal(row.ending, 'f3a9', 'the last four characters are the only part of the value shown');
  assert.equal(row.reach, null, 'a key with no narrower reach has the full reach');
  assert.equal(keyExpired(undefined, now), false, 'a key with no expiry never expires');
  assert.equal(expiredWords('2026-11-19T00:00:00.000Z'), 'This personal key expired at 2026-11-19T00:00:00.000Z. Its person can extend it on their account page, or make a new key.');
});

test('the list shows the caller\'s keys, newest first, at most the list maximum, and says whether there are more', () => {
  const entries = Array.from({ length: PERSONAL_KEYS.list_max + 2 }, (_, index) => ({
    id: String(index).padStart(64, '0'), created_at: new Date(now + index * 1000).toISOString(),
  }));
  const page = personalKeysPage({ entries, now, within });
  assert.equal(page.keys.length, PERSONAL_KEYS.list_max);
  assert.equal(page.more, true);
  assert.equal(page.keys[0].created_at, entries.at(-1).created_at, 'newest first');
});

test('a caller lists only the keys whose reach is within its own', () => {
  const entries = [
    { id: ID, created_at: '2026-11-02T00:00:00.000Z', reach: ['mail:read'] },
    { id: OTHER, created_at: '2026-11-03T00:00:00.000Z', reach: ['mail:read', 'files:write'] },
  ];
  const seen = personalKeysPage({ entries, caller: { reach: ['mail:read'], expires_at: null }, now, within });
  assert.deepEqual(seen.keys.map(row => row.id), [ID]);
  assert.equal(manages(within, { reach: null }, entries[1]), true, 'a full-reach caller manages every key');
  assert.equal(manages(within, null, entries[1]), true, 'no caller given: every key');
});

test('an expiry is an ISO time, never (null), or nothing asked; it is refused past the maximum and when it is not in the future', () => {
  assert.equal(expiryFrom({}, now), undefined);
  assert.equal(expiryFrom({ expires_in: null }, now), null);
  assert.equal(expiryFrom({ expires_in: 3600 }, now), new Date(now + 3600_000).toISOString());
  assert.equal(expiryFrom({ expires_at: new Date(now + 60_000).toISOString() }, now), new Date(now + 60_000).toISOString());
  assert.throws(() => expiryFrom({ expires_in: 0 }, now), error => error.status === 400);
  assert.throws(() => expiryFrom({ expires_in: PERSONAL_KEYS.expires_in_max_seconds + 1 }, now), error => error.status === 400);
  assert.throws(() => expiryFrom({ expires_at: new Date(now - 1000).toISOString() }, now), error => error.status === 400);
});

test('the account page\'s expiry choice is one of its seconds, or never, or nothing', () => {
  assert.deepEqual(expiryOfChoice(''), {});
  assert.deepEqual(expiryOfChoice('never'), { expires_at: null });
  assert.deepEqual(expiryOfChoice('86400'), { expires_in: 86400 });
  assert.throws(() => expiryOfChoice('12345'), error => error.status === 400);
});

test('a key cannot outlive the sign-in that sets its expiry', () => {
  const callerEnds = '2026-11-20T13:00:00.000Z';
  assert.doesNotThrow(() => lastsWithin('2026-11-20T12:30:00.000Z', callerEnds));
  assert.throws(() => lastsWithin('2026-11-20T14:00:00.000Z', callerEnds), error => error.status === 403);
  assert.throws(() => lastsWithin(null, callerEnds), error => error.status === 403, 'never is refused under a timed sign-in');
  assert.doesNotThrow(() => lastsWithin(null, null), 'a sign-in that never ends can give any expiry');
});

test('a key is turned off for its own account, and a stranger or a missing key is "not yours"', () => {
  const saved = { userId: 'user-a' };
  const entry = { id: ID, name: 'Script' };
  assert.deepEqual(endKeyDecision({ id: ID, saved, entry, userId: 'user-a', within }), { id: ID, name: 'Script' });
  assert.throws(() => endKeyDecision({ id: ID, saved, entry, userId: 'user-b', within }), error => error.status === 404);
  assert.throws(() => endKeyDecision({ id: ID, saved: null, entry: null, userId: 'user-a', within }), error => error.status === 404, 'already off');
  assert.throws(() => endKeyDecision({ id: 'not-a-key', saved, entry, userId: 'user-a', within }), error => error.status === 404, 'a malformed id');
  assert.equal(isKeyId(ID), true);
  assert.equal(isKeyId(ID.toUpperCase()), false);
});

test('a list entry whose record is gone can be taken away, unless the caller holds the key', () => {
  const entry = { id: ID };
  assert.deepEqual(endKeyDecision({ id: ID, saved: null, entry, userId: 'user-a', within }), { id: ID });
  assert.throws(() => endKeyDecision({ id: ID, saved: null, entry, userId: 'user-a', within, listedOnly: false }), error => error.status === 404);
  assert.deepEqual(endKeyDecision({ id: ID, saved: { userId: 'user-a' }, entry, userId: 'user-a', within, held: true }), { id: ID });
});

test('a caller that reaches less than the key cannot turn it off, but a holder of the key can', () => {
  const saved = { userId: 'user-a' };
  const entry = { id: ID, reach: ['files:write'] };
  const narrow = { reach: ['mail:read'], expires_at: null };
  assert.throws(() => endKeyDecision({ id: ID, saved, entry, userId: 'user-a', caller: narrow, within }), error => error.status === 403);
  assert.deepEqual(endKeyDecision({ id: ID, saved, entry, userId: 'user-a', caller: narrow, within, held: true }), { id: ID, reach: ['files:write'] });
  assert.equal(endedWords(), 'The key is off. Apps using it stop working on their next call.');
});
