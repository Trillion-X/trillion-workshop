import assert from 'node:assert/strict';
import test from 'node:test';
import {matchRanges} from './match-ranges.ts';

test('maps lowercase expansion back to its original UTF-16 character', () => {
  assert.deepEqual(matchRanges('i', 'İ'), [[0, 0]]);
});

test('keeps source offsets correct after an earlier lowercase expansion', () => {
  assert.deepEqual(matchRanges('invoice', 'İ—Invoice'), [[2, 8]]);
});

test('maps both UTF-16 units of an exact astral match', () => {
  assert.deepEqual(matchRanges('😀', '😀'), [[0, 1]]);
});

test('counts astral characters in the original UTF-16 string', () => {
  assert.deepEqual(matchRanges('invoice', '😀Invoice'), [[2, 8]]);
});

test('uses context-sensitive whole-string lowercase for Greek final sigma', () => {
  assert.deepEqual(matchRanges('ος', 'ΟΣ'), [[0, 1]]);
});
