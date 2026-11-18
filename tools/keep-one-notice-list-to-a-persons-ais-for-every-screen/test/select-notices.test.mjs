import test from 'node:test';
import assert from 'node:assert/strict';
import { unseenFor } from '../src/select-notices.mjs';

const rules = { first_look_hours: 24, most_at_once: 2 };
const now = Date.parse('2026-11-18T10:00:00Z');
const at = (hours, seq, extra = {}) => ({ seq, key: `n${seq}`, at: new Date(now - hours * 3_600_000).toISOString(), from_reader: null, for_reader: null, ...extra });

test('a reader with no cursor is shown only the first-look window, the newest most_at_once of them, and its claim starts from nothing', () => {
  const notices = [at(30, 1), at(5, 2), at(4, 3), at(1, 4)];
  const found = unseenFor({ notices, cursor: null, reader: 'app:Codex', now, rules });
  assert.deepEqual(found.notices.map(n => n.seq), [3, 4]);
  assert.deepEqual(found.claim, { reader: 'app:Codex', from: null, upto: 4, shown: [3, 4] });
});

test('a cursor shows only what is above it; a reader that holds the newest seq has nothing and no claim', () => {
  const notices = [at(3, 1), at(2, 2), at(1, 3)];
  assert.deepEqual(unseenFor({ notices, cursor: { seq: 2 }, reader: 'app:Codex', now, rules }).notices.map(n => n.seq), [3]);
  assert.deepEqual(unseenFor({ notices, cursor: { seq: 3 }, reader: 'app:Codex', now, rules }), { notices: [], claim: null });
});

test('a notice made by the reader is never shown to it; a notice addressed to another reader is never shown to it', () => {
  const notices = [at(2, 1, { from_reader: 'app:Codex' }), at(2, 2, { for_reader: 'app:Other' }), at(2, 3)];
  assert.deepEqual(unseenFor({ notices, cursor: { seq: 0 }, reader: 'app:Codex', now, rules }).notices.map(n => n.seq), [3]);
});

test('an addressed notice is shown before anything else, and is never crowded out by the notices every reader is shown', () => {
  const notices = [at(2, 1), at(2, 2), at(2, 3), at(2, 4, { for_reader: 'app:Codex' })];
  const found = unseenFor({ notices, cursor: { seq: 0 }, reader: 'app:Codex', now, rules });
  assert.deepEqual(found.notices.map(n => n.seq), [1, 4]);
  // the addressed notice jumps ahead; the claim advances only the contiguous frontier, so notice 2 (left out) caps it at 1
  assert.equal(found.claim.upto, 1);
});

test('when a notice is left out, the claim spends only up to the one before it', () => {
  const notices = [at(2, 1), at(2, 2), at(2, 3), at(2, 4)];
  const found = unseenFor({ notices, cursor: { seq: 0 }, reader: 'app:Other', now, rules });
  assert.deepEqual(found.notices.map(n => n.seq), [1, 2]);
  assert.deepEqual(found.claim, { reader: 'app:Other', from: 0, upto: 2, shown: [1, 2] });
});
