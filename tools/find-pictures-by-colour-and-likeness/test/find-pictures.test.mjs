import test from 'node:test';
import assert from 'node:assert/strict';
import { findPictures } from '../do-work/find-pictures.mjs';

const rows = [
  { id: 'sea', palette: ['#1e5aa8', '#ffffff'], embedding: [1, 0, 0] },
  { id: 'sky', palette: ['#2060b0', '#eeeeee'], embedding: [0.9, 0.1, 0] },
  { id: 'fire', palette: ['#d02010', '#ffcc00'], embedding: [0, 0, 1] },
];
test('the row finds pictures by a typed colour, by colour words in a question and by likeness, and asks one thing', () => {
  assert.deepEqual(findPictures({ rows, colour: '#1f5ba9' }).ids, ['sea', 'sky']);
  assert.deepEqual(findPictures({ rows, question: 'the #d02010 ones' }).ids, ['fire']);
  const like = findPictures({ rows, like: 'sea' });
  assert.equal(like.ids.includes('sea'), false, 'the anchor is never its own result');
  assert.throws(() => findPictures({ rows, colour: '#1f5ba9', like: 'sea' }), /Ask one thing/);
  assert.throws(() => findPictures({ rows, like: 'nope' }), /No row has the id nope/);
});
