// tools/save-what-you-watch-and-read/test/composio-source.test.mjs: the bookmarks read through the person's X account that
// Composio holds. Composio is stubbed with X's own page shape; the test checks the arguments, the paging and the posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFromComposio, pageIn, argumentsFor } from '../do-work/composio-source.mjs';
import { collector } from '../do-work/saved-source.mjs';
import { listFor } from '../do-work/saved-source.mjs';

const xPost = (id, author = '100') => ({ id, text: `post ${id}`, author_id: author, created_at: '2026-09-02T16:50:26.000Z', entities: { urls: [] } });
const users = { includes: { users: [{ id: '100', username: 'sample_maker', name: 'Sample Maker' }] } };

test('the answer is unwrapped to X\'s page, whether Composio wraps it in data or in data_preview', () => {
  const page = { data: [xPost('9')], ...users, meta: { result_count: 1 } };
  assert.equal(pageIn({ data: { data: page.data, ...users, meta: page.meta } }).data[0].id, '9');
  assert.equal(pageIn({ data: { data: { data: page.data, ...users, meta: page.meta } } }).data[0].id, '9');
  assert.equal(pageIn({ data_preview: { data: page } }).data[0].id, '9');
  assert.deepEqual(pageIn({ data: { data: [] } }).data, []);
});

test('each page asks for the person\'s own bookmarks with the fields the parser reads, and the next page passes its token back', async () => {
  const calls = [];
  const execute = async (tool, account, args, userId) => {
    calls.push({ tool, account, args, userId });
    if (calls.length === 1) return { data: { data: [xPost('9')], ...users, meta: { next_token: 'tok-2' } } };
    return { data: { data: [xPost('5')], ...users, meta: {} } };
  };
  const collected = collector([]);
  const pages = await readFromComposio({ which: 'bookmarks', account: 'twitter_terma-weedy', user_id: 'me-user' }, collected, { execute });
  assert.equal(pages, 2);
  assert.deepEqual(calls.map(call => call.tool), ['TWITTER_BOOKMARKS_BY_USER', 'TWITTER_BOOKMARKS_BY_USER']);
  assert.ok(calls.every(call => call.account === 'twitter_terma-weedy' && call.userId === 'me-user'));
  assert.equal(calls[0].args.id, 'me');
  assert.equal(calls[0].args.max_results, 100);
  assert.equal(calls[0].args.pagination_token, undefined);
  assert.equal(calls[1].args.pagination_token, 'tok-2');
  assert.deepEqual(collected.posts().map(post => post.key), ['9', '5']);
  assert.equal(collected.posts()[0].author, 'sample_maker');
});

test('the likes are not read through Composio, and a missing account is refused before any call', async () => {
  const execute = async () => { throw new Error('no call expected'); };
  await assert.rejects(readFromComposio({ which: 'likes', account: 'x' }, collector([]), { execute }), /bookmarks only/);
  await assert.rejects(readFromComposio({ which: 'bookmarks' }, collector([]), { execute }), /Give account/);
});

test('the arguments carry the list\'s page size and no token on the first page', () => {
  const kind = listFor({ which: 'bookmarks' });
  const args = argumentsFor(kind, undefined);
  assert.equal(args.max_results, kind.page_size);
  assert.ok(args.expansions.includes('author_id'));
  assert.equal('pagination_token' in args, false);
});
