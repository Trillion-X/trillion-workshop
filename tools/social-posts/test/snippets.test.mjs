// Filling a snippet's blanks (read-data/snippets.mjs): the record is handed in and nothing is written. Saving, finding and
// removing a snippet are the store's job and are proven by test/keep-recipes-proof.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSnippets } from '../read-data/snippets.mjs';

const record = { snippet_id: 'snippet:2026-10-01T09:00:00.000Z:a1b2c3d4e5', title: 'Say no kindly', text: 'Hi {name}, thank you for thinking of me for {thing}. I have to pass this time.', tags: ['replies'], set_at: '2026-10-01T09:00:00.000Z', uses: 0 };
const eeaf = { read: id => (id === record.snippet_id ? structuredClone(record) : null) };

test('a use fills the blanks given, names the ones left, and writes nothing', () => {
  const used = makeSnippets({ eeaf }).use({ snippet_id: record.snippet_id, values: { name: 'Sam' } });
  assert.equal(used.text, 'Hi Sam, thank you for thinking of me for {thing}. I have to pass this time.');
  assert.deepEqual(used.left_blank, ['thing']);
  assert.equal(used.said, 'Left blank: thing.');
  assert.equal(record.text.includes('Sam'), false, 'the snippet\'s own words are never rewritten');
});

test('a use with every blank filled names none left', () => {
  const used = makeSnippets({ eeaf }).use({ snippet_id: record.snippet_id, values: { name: 'Sam', thing: 'the deck' } });
  assert.deepEqual(used.left_blank, []);
  assert.equal(used.said, undefined);
});

test('a use of a snippet that is not handed in is refused', () => {
  assert.throws(() => makeSnippets({ eeaf }).use({ snippet_id: 'snippet:none' }), /There is no snippet snippet:none\./);
});
