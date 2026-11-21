// tools/social-posts/test/words-of-utm.test.mjs: every link a destination is sent is tagged with the UTM parameters from
// the post and its place (read-data/posts.json link_tags), the call to action's link inside the words included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordsOf } from '../read-data/posts.mjs';

const instagram = { platform: 'instagram' };
const post = { post_id: 'ep1-journey', caption: 'Watch the first one.\n\nBook a lesson: https://ethosschooloftennis.com/book.' };

test('a link in the words is tagged for its destination, and sentence punctuation after it stays outside the link', () => {
  const words = wordsOf(post, instagram, 'account-1');
  assert.equal(
    words,
    'Watch the first one.\n\nBook a lesson: https://ethosschooloftennis.com/book?utm_source=instagram&utm_medium=social&utm_content=ep1-journey&utm_campaign=ep1-journey.',
  );
});

test('the post\'s own link is tagged and joined after the words', () => {
  const words = wordsOf({ ...post, caption: 'Out now.', link: 'https://ethosschooloftennis.com/journey' }, { platform: 'youtube' }, 'account-2');
  assert.equal(
    words,
    'Out now.\n\nhttps://ethosschooloftennis.com/journey?utm_source=youtube&utm_medium=social&utm_content=ep1-journey&utm_campaign=ep1-journey',
  );
});

test('the platform caption is used, and each link in it is tagged for that platform', () => {
  const each = { ...post, caption: 'a https://ethosschooloftennis.com/a', caption_by_platform: { x: 'b https://ethosschooloftennis.com/b and https://ethosschooloftennis.com/c' } };
  assert.equal(
    wordsOf(each, { platform: 'x' }, 'account-3'),
    'b https://ethosschooloftennis.com/b?utm_source=x&utm_medium=social&utm_content=ep1-journey&utm_campaign=ep1-journey and https://ethosschooloftennis.com/c?utm_source=x&utm_medium=social&utm_content=ep1-journey&utm_campaign=ep1-journey',
  );
});

test('a link written in HTML keeps its query: the ampersands are read as plain ones and written back as &amp;', () => {
  const html = '<p>See <a href="https://ethosschooloftennis.com/a?b=1&amp;c=2">this</a>.</p>';
  assert.equal(
    wordsOf({ post_id: 'ep1-journey', caption: html }, instagram, 'account-1'),
    '<p>See <a href="https://ethosschooloftennis.com/a?b=1&amp;c=2&amp;utm_source=instagram&amp;utm_medium=social&amp;utm_content=ep1-journey&amp;utm_campaign=ep1-journey">this</a>.</p>',
  );
});

test('words with no link are sent as written', () => {
  assert.equal(wordsOf({ post_id: 'p', caption: 'No link here.' }, instagram, 'account-1'), 'No link here.');
});
