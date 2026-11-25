import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalWords } from '../show/refusal-words.ts';

test('a refusal shows the tool\'s why when there is one, else the row\'s error, else the page\'s failed words', () => {
  assert.equal(refusalWords({ error: 'Could not save that.', why: 'An answer is written as text.' }, 'Something went wrong.'), 'An answer is written as text.');
  assert.equal(refusalWords({ error: 'Could not save that.' }, 'Something went wrong.'), 'Could not save that.');
  assert.equal(refusalWords({ error: 'Could not save that.', why: '  ' }, 'Something went wrong.'), 'Could not save that.');
  assert.equal(refusalWords({ error: 7, why: { x: 1 } }, 'Something went wrong.'), 'Something went wrong.');
  assert.equal(refusalWords({}, 'Something went wrong.'), 'Something went wrong.');
  assert.equal(refusalWords(null, 'Something went wrong.'), 'Something went wrong.');
});
