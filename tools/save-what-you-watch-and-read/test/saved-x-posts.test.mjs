// Tests for tools/save-what-you-watch-and-read: how X's list answers become posts, and when a read of them stops.
// Every account, name and address below is made up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFromApi, tokenFrom } from '../do-work/api-source.mjs';
import { pageFor } from '../do-work/browser-source.mjs';
import { readSaved } from '../do-work/read-saved-x-posts.mjs';
import { collector, savedPost } from '../do-work/saved-source.mjs';
import { apiPostsIn, linksOf, postsIn } from '../do-work/x-posts.mjs';

function tweet(id, text, extra = {}) {
  return {
    rest_id: id,
    core: { user_results: { result: { core: { screen_name: 'sample_maker', name: 'Sample Maker' } } } },
    legacy: { full_text: text, created_at: 'Wed Sep 02 16:50:26 +0000 2026', ...extra.legacy },
    ...(extra.top ?? {}),
  };
}

const entry = result => ({ content: { itemContent: { tweet_results: { result } } } });

test('an answer becomes posts in the order X listed them, each once', () => {
  const answer = { data: { timeline: { instructions: [{ entries: [entry(tweet('1', 'first')), entry(tweet('2', 'second')), entry(tweet('1', 'first again'))] }] } } };
  const posts = postsIn(answer);
  assert.deepEqual(posts.map(post => post.key), ['1', '2']);
  assert.equal(posts[0].url, 'https://x.com/sample_maker/status/1');
  assert.equal(posts[0].author_name, 'Sample Maker');
  assert.equal(posts[0].posted_at, '2026-09-02T16:50:26.000Z');
});

test('a long post gives its full text and the visibility wrapper is opened', () => {
  const long = tweet('3', 'cut off…', { top: { note_tweet: { note_tweet_results: { result: { text: 'the whole long text' } } } } });
  const posts = postsIn({ entries: [entry({ __typename: 'TweetWithVisibilityResults', tweet: long })] });
  assert.equal(posts[0].title, 'the whole long text');
});

test('links are the real addresses the author wrote, not their picture addresses', () => {
  const t = tweet('4', 'see https://t.co/aaa', {
    legacy: {
      entities: {
        urls: [
          { url: 'https://t.co/aaa', expanded_url: 'https://example.org/sample-repo' },
          { url: 'https://t.co/bbb', expanded_url: 'https://x.com/sample_maker/status/4/photo/1' },
          { url: 'https://t.co/ccc', expanded_url: 'https://example.org/sample-repo' },
        ],
      },
    },
  });
  assert.deepEqual(linksOf(t), ['https://example.org/sample-repo']);
  assert.deepEqual(postsIn({ entries: [entry(t)] })[0].links, ['https://example.org/sample-repo']);
});

test('a quoted post is kept beside the post that quotes it, one level deep', () => {
  const inner = tweet('6', 'the quoted words', { legacy: { entities: { urls: [{ expanded_url: 'https://example.org/inner' }] } } });
  const outer = tweet('5', 'my words', { top: { quoted_status_result: { result: inner } } });
  const [post] = postsIn({ entries: [entry(outer)] });
  assert.equal(post.quoted.key, '6');
  assert.deepEqual(post.quoted.links, ['https://example.org/inner']);
  assert.equal(post.quoted.quoted, undefined);
});

test('an entry without an id or text record is skipped', () => {
  assert.deepEqual(postsIn({ entries: [entry({ rest_id: '7' }), entry(undefined), entry({ legacy: {} })] }), []);
});

test('the read stops after several pages that hold only posts the person already has', () => {
  const posts = ids => ids.map(key => ({ key }));
  const read = collector(['1', '2', '3', '4']);
  assert.equal(read.onPage(posts(['9', '1'])), true);
  assert.equal(read.onPage(posts(['2', '3'])), false);
  assert.equal(read.onPage(posts(['4'])), false);
  assert.equal(read.onPage.finished(), false);
  read.onPage(posts(['1']));
  assert.equal(read.onPage.finished(), true);
  assert.deepEqual(read.posts().map(post => post.key), ['9', '1', '2', '3', '4']);
  assert.equal(read.notKept(), 1);
});

test('an empty page is not a quiet page', () => {
  const read = collector([]);
  for (let i = 0; i < 5; i += 1) read.onPage([]);
  assert.equal(read.onPage.finished(), false);
});

test('a saved post keeps an identity per way it was saved', () => {
  assert.equal(savedPost({ key: '9' }, 'bookmarks').id, 'x-bookmark-9');
  assert.equal(savedPost({ key: '9' }, 'likes').id, 'x-like-9');
  assert.equal(savedPost({ key: '9' }, 'likes').saved_from, 'X');
});

test('likes need the person\'s X name and a kind of list that does not exist is refused', () => {
  assert.throws(() => pageFor({ which: 'likes' }), /needs handle/);
  assert.equal(pageFor({ which: 'likes', handle: 'sample_person' }).pageAddress, 'https://x.com/sample_person/likes');
  assert.equal(pageFor({ which: 'bookmarks' }).pageAddress, 'https://x.com/i/bookmarks');
  assert.throws(() => pageFor({ which: 'follows' }), /which must be one of/);
});
