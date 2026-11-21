// tools/social-posts/test/tag-the-links.test.mjs: tool:tag-the-links-in-words tags every link in the words with the caller's
// source, medium, campaign and content, through the same tagger the posts use, and refuses a call that names no value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagTheLinksInWords } from '../read-data/tag-the-links.mjs';
import { tagWords, wordsOf } from '../read-data/posts.mjs';

const reply = { source: 'instagram', medium: 'dm', campaign: 'reply-rule:swing-link', content: 'comment-17' };

test('each link is tagged with the caller\'s parameters and the sentence punctuation after it stays outside the link', () => {
  const { words, links } = tagTheLinksInWords({ ...reply, words: 'Here is the step by step: https://example.test/swing. Also https://example.test/book!' });
  const [first, second] = links.map(link => new URL(link));
  assert.equal(first.origin + first.pathname, 'https://example.test/swing');
  assert.equal(second.origin + second.pathname, 'https://example.test/book');
  for (const url of [first, second]) {
    assert.equal(url.searchParams.get('utm_source'), 'instagram');
    assert.equal(url.searchParams.get('utm_medium'), 'dm');
    assert.equal(url.searchParams.get('utm_campaign'), 'reply-rule:swing-link');
    assert.equal(url.searchParams.get('utm_content'), 'comment-17');
  }
  assert.equal(words, `Here is the step by step: ${links[0]}. Also ${links[1]}!`);
});

test('the answer\'s words are the words sent: the tagged links are the ones in them, in order', () => {
  const { words, links } = tagTheLinksInWords({ ...reply, words: 'Go to https://example.test' });
  assert.deepEqual(links, [words.slice('Go to '.length)]);
});

test('words with no link come back as written, with no links', () => {
  assert.deepEqual(tagTheLinksInWords({ ...reply, words: 'No link here.' }), { words: 'No link here.', links: [] });
});

test('a link written in HTML keeps its query, and the ampersands are written back as &amp;', () => {
  const { words } = tagTheLinksInWords({ ...reply, words: '<a href="https://example.test/a?b=1&amp;c=2">this</a>' });
  assert.match(words, /^<a href="https:\/\/example\.test\/a\?b=1&amp;c=2&amp;utm_source=instagram&amp;utm_medium=dm&amp;utm_content=comment-17&amp;utm_campaign=reply-rule%3Aswing-link">this<\/a>$/);
});

test('the same tagger as a post: the same link gets the same tags as a post sent to the same place', () => {
  const post = { post_id: 'ep1-journey', caption: 'Book a lesson: https://example.test/book.' };
  const sent = wordsOf(post, { platform: 'instagram' }, 'account-1');
  const { words } = tagTheLinksInWords({ source: 'instagram', medium: 'social', campaign: 'ep1-journey', content: 'ep1-journey::account-1', words: post.caption });
  assert.equal(words, sent);
});

test('a call that names no value is refused, naming the value', () => {
  assert.throws(() => tagTheLinksInWords({ source: 'instagram', campaign: 'c', content: 'x', words: 'a' }), /needs medium/);
  assert.throws(() => tagTheLinksInWords({ ...reply, source: '', words: 'a' }), /needs source/);
  assert.throws(() => tagTheLinksInWords({ ...reply }), /needs words/);
});

test('tagWords tags only the links its predicate names; the others come back as written', () => {
  const tags = { utm_medium: 'email' };
  assert.equal(
    tagWords('Go https://example.test/a and https://other.test/b', tags, href => href.includes('example.test')),
    'Go https://example.test/a?utm_medium=email and https://other.test/b',
  );
});
