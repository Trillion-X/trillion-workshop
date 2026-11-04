// Snippets (read-data/snippets.mjs, moved from trillion test/snippets.test.mjs): saved once, found, filled, counted and removed.
// Trillion's second test (the tools and the page road reach the same snippets) runs trillion's own callers
// (src/social-posts.mjs, src/work-posts.mjs, src/social-post-tools.mjs), which stay there; it is not moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { posts } from './drafts-for-tests.mjs';

test('save, find, fill, count, change and remove a snippet', () => {
  const { owner } = posts();
  const { snippets } = owner;
  const made = snippets.save({ title: 'Say no kindly', text: 'Hi {name}, thank you for thinking of me for {thing}. I have to pass this time.', tags: ['Replies', 'no'] }).snippet;
  assert.deepEqual(made.blanks, ['name', 'thing']);
  assert.deepEqual(made.tags, ['replies', 'no']);
  assert.equal(snippets.list({ query: 'kindly' }).snippets.length, 1);
  assert.equal(snippets.list({ tag: 'replies' }).snippets.length, 1);
  assert.equal(snippets.list({ query: 'zebra' }).snippets.length, 0);
  const used = snippets.use({ snippet_id: made.snippet_id, values: { name: 'Sam' } });
  console.log('SNIPPET READBACK:', JSON.stringify({ text: used.text, left_blank: used.left_blank, said: used.said }));
  assert.equal(used.text, 'Hi Sam, thank you for thinking of me for {thing}. I have to pass this time.');
  assert.deepEqual(used.left_blank, ['thing']);
  assert.equal(snippets.list({}).snippets[0].uses, 1);
  assert.equal(snippets.list({}).snippets[0].text, made.text, 'a use never rewrites the words');
  const changed = snippets.save({ snippet_id: made.snippet_id, title: 'Decline kindly' }).snippet;
  assert.equal(changed.text, made.text);
  assert.throws(() => snippets.save({ snippet_id: made.snippet_id, text: 'x', expected_set_at: 'long ago' }), /saved again at/);
  assert.throws(() => snippets.save({ title: '', text: 'x' }), /needs a title/);
  assert.match(snippets.remove({ snippet_id: made.snippet_id }).said, /Removed the snippet "Decline kindly"/);
  assert.throws(() => snippets.use({ snippet_id: made.snippet_id }), /There is no snippet/);
});
