// test/range-edits.test.mjs: an edit is kept ranges over the original, so it cannot invent; exports wait for ready pieces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyKept, checkOutputLength, coverage, keptRanges, keptTotal, refuseUntilReady, removedRanges } from '../do-work/range-edits.mjs';

test('kept ranges are sorted, merged when touching, and the removed ranges are the rest', () => {
  const kept = keptRanges([{ start: 10, end: 20 }, { start: 0, end: 5 }, { start: 5, end: 8 }], 30);
  assert.deepEqual(kept, [{ start: 0, end: 8 }, { start: 10, end: 20 }]);
  assert.deepEqual(removedRanges(kept, 30), [{ start: 8, end: 10 }, { start: 20, end: 30 }]);
  assert.equal(keptTotal(kept), 18);
});

test('the type forbids invention: extra fields, text, overlaps, out-of-bounds and empty ranges are refused', () => {
  const bad = ranges => assert.throws(() => keptRanges(ranges, 30), error => error.status === 400);
  bad([{ start: 0, end: 5, text: 'new words' }]);
  bad([{ start: 0, end: 31 }]);
  bad([{ start: -1, end: 4 }]);
  bad([{ start: 5, end: 5 }]);
  bad([{ start: 0, end: 10 }, { start: 9, end: 12 }]);
  bad('keep everything');
  bad([null]);
});

test('applying an edit returns only original items, in order, that sit wholly inside a kept range', () => {
  const words = [{ w: 'a', start: 0, end: 1 }, { w: 'um', start: 1, end: 2 }, { w: 'b', start: 2, end: 3 }, { w: 'c', start: 2.5, end: 4 }];
  const kept = keptRanges([{ start: 0, end: 1 }, { start: 2, end: 3 }], 4);
  assert.deepEqual(applyKept(words, kept).map(word => word.w), ['a', 'b']);
});

test('the produced length must match the promise within the caller\'s tolerance', () => {
  const kept = keptRanges([{ start: 0, end: 10 }], 30);
  assert.equal(checkOutputLength(kept, 10.04, 0.1).ok, true);
  assert.equal(checkOutputLength(kept, 12, 0.1).ok, false);
  assert.equal(checkOutputLength(kept, NaN, 0.1).ok, false);
});

test('export waits until pieces in a ready state cover every kept second, and says where it is missing', () => {
  const kept = keptRanges([{ start: 0, end: 10 }, { start: 20, end: 30 }], 40);
  const ready = ['done'];
  const segments = [{ start: 0, end: 10, state: 'done' }, { start: 20, end: 25, state: 'done' }, { start: 25, end: 30, state: 'working' }];
  const found = coverage(kept, segments, ready);
  assert.equal(found.ready, false);
  assert.deepEqual(found.gaps, [{ start: 25, end: 30 }]);
  assert.equal(found.pending.length, 1);
  assert.throws(() => refuseUntilReady(kept, segments, ready, 'the person masks'), error => error.status === 409 && error.retry === true && /person masks do not yet cover 25 to 30/.test(error.message));
  segments[2].state = 'done';
  assert.equal(refuseUntilReady(kept, segments, ready).ready, true);
  assert.equal(coverage(kept, [], ready).ready, false);
});
