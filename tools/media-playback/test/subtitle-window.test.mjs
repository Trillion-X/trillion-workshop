// Tests for the subtitle window (read-data/subtitle-window.mjs). The passages are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SUBTITLE_WORDS, subtitleWordsOf } from '../read-data/subtitle-window.mjs';

const passage = count => ({
  text: Array.from({ length: count }, (_, i) => `w${i}`).join(' '),
  words: Array.from({ length: count }, (_, i) => ({ word: `w${i}`, start: i, end: i + 0.9 })),
});

test('a short passage shows all its words, and the word being said is the one marked', () => {
  const window = subtitleWordsOf(passage(4), 2.5);
  assert.deepEqual(window.words.map(word => word.word), ['w0', 'w1', 'w2', 'w3']);
  assert.equal(window.activeIndex, 2);
  assert.deepEqual(window.words.filter(word => word.active).map(word => word.word), ['w2']);
});

test('a long passage shows a window of at most the word limit that contains the word being said', () => {
  const long = passage(60);
  for (const moment of [0.2, 10.5, 30.1, 58.9]) {
    const window = subtitleWordsOf(long, moment);
    assert.ok(window.words.length <= SUBTITLE_WORDS, `window at ${moment} is ${window.words.length} words`);
    assert.ok(window.words.some(word => word.active), `no active word at ${moment}`);
  }
});

test('between two words the last word said is the one kept in the window', () => {
  const window = subtitleWordsOf(passage(3), 1.95);
  assert.equal(window.activeIndex, 1);
  assert.ok(window.words.some(word => word.word === 'w1' && word.active));
});

test('a passage with no words gives no window, and its text is what the caller shows', () => {
  assert.deepEqual(subtitleWordsOf({ text: 'Whole passage.' }, 3), { words: [], activeIndex: -1, text: 'Whole passage.' });
  assert.deepEqual(subtitleWordsOf(undefined, 3), { words: [], activeIndex: -1, text: '' });
});
