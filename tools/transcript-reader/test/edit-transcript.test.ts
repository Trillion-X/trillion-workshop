// Tests for rewording a passage (read-data/edit-transcript.ts rewordPassage). The passages are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rewordPassage } from '../read-data/edit-transcript.ts';

const passages = [
  { start: 0, end: 2, text: 'the cort is fixed', words: [{ word: 'the', start: 0, end: 0.4 }, { word: 'cort', start: 0.4, end: 1 }, { word: 'is', start: 1, end: 1.4 }, { word: 'fixed', start: 1.4, end: 2 }] },
  { start: 2, end: 3, text: 'next one', words: [{ word: 'next', start: 2, end: 2.5 }, { word: 'one', start: 2.5, end: 3 }] },
];

test('a spelling fix keeps every word on its own seconds and changes no other passage', () => {
  const after = rewordPassage(passages, 0, 'the court is fixed');
  assert.equal(after[0].text, 'the court is fixed');
  assert.deepEqual(after[0].words!.map(word => [word.word, word.start, word.end]), [['the', 0, 0.4], ['court', 0.4, 1], ['is', 1, 1.4], ['fixed', 1.4, 2]]);
  assert.equal(after[1], passages[1]);
  assert.equal(passages[0].text, 'the cort is fixed');
});

test('a passage written with fewer or more words shares its own span evenly, ending where it ended', () => {
  const after = rewordPassage(passages, 0, '  the   court  ');
  assert.deepEqual(after[0].words!.map(word => [word.word, word.start, word.end]), [['the', 0, 1], ['court', 1, 2]]);
  assert.equal(after[0].start, 0);
  assert.equal(after[0].end, 2);
  const longer = rewordPassage(passages, 1, 'the next one here');
  assert.equal(longer[1].words!.length, 4);
  assert.equal(longer[1].words![0].start, 2);
  assert.equal(longer[1].words![3].end, 3);
});

test('a passage cannot be emptied, and a passage that is gone is refused', () => {
  assert.throws(() => rewordPassage(passages, 0, '   '), /needs words/);
  assert.throws(() => rewordPassage(passages, 5, 'x'), /no longer/);
});

test('a passage kept without words takes the new text alone', () => {
  const after = rewordPassage([{ start: 0, end: 1, text: 'old' }], 0, 'new words');
  assert.deepEqual(after, [{ start: 0, end: 1, text: 'new words' }]);
});
