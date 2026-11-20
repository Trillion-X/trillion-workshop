// The old test/space-search.test.mjs assertions at b6ae0ebf815f that a post can carry, on made-up posts. Not carried: the
// withdrawn and hidden rules and the kind filter. Current posts have no withdrawn, hidden or kind field (tool:list-a-spaces-posts
// answers { item_id, author, fields, posted_at } only), so those outcomes wait for the post owner to add the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSpacePosts, searchWords } from '../do-work/search-a-spaces-posts.mjs';

const post = (item_id, text, posted_at) => ({ item_id, author: 'owner@example.com', fields: { text }, posted_at });

test('the query is its distinct lower-cased words, bounded', () => {
  assert.deepEqual(searchWords('  Budget  BUDGET plan '), ['budget', 'plan']);
  assert.equal(searchWords('   '), null);
  assert.equal(searchWords(undefined), null);
  assert.equal(searchWords('a b c d e f g h i j').length, 8);
  assert.equal(searchWords('x'.repeat(80))[0].length, 64);
});

test('every word must be in the post, newest first', () => {
  const posts = [
    post('item_1', 'Budget plan for the autumn', '2026-11-01T00:00:00.000Z'),
    post('item_2', 'Budget only', '2026-11-02T00:00:00.000Z'),
    post('item_3', 'Autumn budget plan, revised', '2026-11-03T00:00:00.000Z'),
  ];
  const found = searchSpacePosts({ posts, query: 'plan BUDGET' });
  assert.deepEqual(found.items.map(item => item.item_id), ['item_3', 'item_1']);
  assert.equal(found.next_before, null);
  assert.deepEqual(searchSpacePosts({ posts, query: 'revised' }).items.map(item => item.item_id), ['item_3']);
});

test('a % or _ in the words is a plain character', () => {
  const posts = [post('item_1', 'up 100 percent', '2026-11-01T00:00:00.000Z'), post('item_2', '100% done', '2026-11-02T00:00:00.000Z')];
  assert.deepEqual(searchSpacePosts({ posts, query: '100%' }).items.map(item => item.item_id), ['item_2']);
  assert.deepEqual(searchSpacePosts({ posts, query: 'p_rcent' }).items, []);
});

test('only the fields a reader sees are searched, and the post comes back as it was given', () => {
  const posts = [{ item_id: 'item_1', author: 'owner@example.com', fields: { text: 'hello', count: 3 }, posted_at: '2026-11-01T00:00:00.000Z' }];
  assert.deepEqual(searchSpacePosts({ posts, query: 'hello' }).items, posts);
  assert.deepEqual(searchSpacePosts({ posts, query: '3' }).items, [], 'a number field is not text the reader is shown as words here');
});

test('a page goes on with next_before and no post repeats', () => {
  const posts = Array.from({ length: 5 }, (_, index) => post(`item_${index}`, `find me ${index}`, `2026-11-0${index + 1}T00:00:00.000Z`));
  const first = searchSpacePosts({ posts, query: 'find', size: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.next_before);
  const second = searchSpacePosts({ posts, query: 'find', size: 2, before: first.next_before });
  assert.equal(second.items.length, 2);
  assert.ok(!second.items.some(item => first.items.some(seen => seen.item_id === item.item_id)));
  const third = searchSpacePosts({ posts, query: 'find', size: 2, before: second.next_before });
  assert.equal(third.items.length, 1);
  assert.equal(third.next_before, null);
});

test('a call examines at most scan_batches pages, then answers next_before for the rest', () => {
  // scan_batches 4 and size 2: one call examines 8 posts. The only match is the oldest of 12.
  const posts = Array.from({ length: 12 }, (_, index) => post(`item_${String(index).padStart(2, '0')}`, index === 0 ? 'needle' : 'hay', `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
  const first = searchSpacePosts({ posts, query: 'needle', size: 2 });
  assert.deepEqual(first.items, []);
  assert.ok(first.next_before, 'more posts remain, so the caller goes on');
  const second = searchSpacePosts({ posts, query: 'needle', size: 2, before: first.next_before });
  assert.deepEqual(second.items.map(item => item.item_id), ['item_00']);
  assert.equal(second.next_before, null);
});

test('a query with no word is refused', () => {
  assert.throws(() => searchSpacePosts({ posts: [], query: '   ' }), /at least one word/);
});
