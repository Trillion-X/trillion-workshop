// Tests for the API way in of tools/save-what-you-watch-and-read: X's pages to posts, the paging, and every refusal.
// Every account, token and address below is made up; no network is touched (the fetch is a stand-in).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFromApi, tokenFrom } from '../do-work/api-source.mjs';
import { readSaved } from '../do-work/read-saved-x-posts.mjs';
import { collector } from '../do-work/saved-source.mjs';
import { apiPostsIn } from '../do-work/x-posts.mjs';

const TOKEN = 'made-up-token-value';

const user = (id, username, name) => ({ id, username, name });
const tweet = (id, text, extra = {}) => ({ id, text, author_id: 'u1', created_at: '2026-09-02T16:50:26.000Z', ...extra });
const page = (data, next, includes = { users: [user('u1', 'sample_maker', 'Sample Maker')] }) => ({ data, includes, meta: next ? { next_token: next } : {} });

function standIn(answers) {
  const calls = [];
  const fetchImpl = async (address, init) => {
    calls.push({ address, authorization: init.headers.Authorization });
    const answer = answers.shift();
    const status = answer.status ?? 200;
    return { ok: status < 300, status, headers: { get: name => answer.headers?.[name] ?? null }, text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)) };
  };
  return { calls, fetchImpl };
}

const me = { body: { data: { id: 'u1', username: 'sample_maker' } } };
const read = () => TOKEN;

test('a page becomes posts with expanded links, pictures, long text and the post it quotes', () => {
  const posts = apiPostsIn(page([
    tweet('1', 'see https://t.co/aaa', {
      entities: { urls: [{ url: 'https://t.co/aaa', expanded_url: 'https://example.org/sample-repo' }, { expanded_url: 'https://x.com/sample_maker/status/1/photo/1' }] },
      attachments: { media_keys: ['m1'] },
    }),
    tweet('2', 'cut off', { note_tweet: { text: 'the whole long text', entities: { urls: [{ expanded_url: 'https://example.org/long' }] } }, referenced_tweets: [{ type: 'quoted', id: '3' }] }),
  ], undefined, {
    users: [user('u1', 'sample_maker', 'Sample Maker'), user('u2', 'quoted_maker', 'Quoted Maker')],
    tweets: [tweet('3', 'quoted words', { author_id: 'u2', referenced_tweets: [{ type: 'quoted', id: '9' }] })],
    media: [{ media_key: 'm1', type: 'photo', url: 'https://example.org/a.jpg' }],
  }));
  assert.deepEqual(posts[0].links, ['https://example.org/sample-repo']);
  assert.deepEqual(posts[0].media, ['https://example.org/a.jpg']);
  assert.equal(posts[0].url, 'https://x.com/sample_maker/status/1');
  assert.equal(posts[1].title, 'the whole long text');
  assert.deepEqual(posts[1].links, ['https://example.org/long']);
  assert.equal(posts[1].quoted.key, '3');
  assert.equal(posts[1].quoted.author, 'quoted_maker');
  assert.equal(posts[1].quoted.quoted, undefined);
});

test('a page with no data and a repeated post give no posts and one post', () => {
  assert.deepEqual(apiPostsIn({ meta: { result_count: 0 } }), []);
  assert.equal(apiPostsIn(page([tweet('1', 'a'), tweet('1', 'a again')])).length, 1);
});

test('no token handed to the run means no network call', async () => {
  const { calls, fetchImpl } = standIn([]);
  assert.throws(() => tokenFrom({ which: "bookmarks" }, () => { throw new Error("EBADF"); }), /No X token was handed/);
  await assert.rejects(readFromApi({ which: "bookmarks" }, collector([]), { fetchImpl, read: () => { throw new Error("EBADF"); } }), /No X token was handed/);
  assert.equal(calls.length, 0);
  assert.throws(() => tokenFrom({ token_fd: 3 }, () => ' \n'), /empty/);
});

test('pages follow the next token until X has no more, asking for the fields that carry links and quotes', async () => {
  const { calls, fetchImpl } = standIn([me, { body: page([tweet('1', 'a'), tweet('2', 'b')], 'next-1') }, { body: page([tweet('3', 'c')]) }]);
  const result = await readSaved({ via: 'api', which: 'bookmarks', token_fd: 3 }, (request, collected) => readFromApi(request, collected, { fetchImpl, read }));
  assert.equal(result.pages, 2);
  assert.deepEqual(result.posts.map(post => post.id), ['x-bookmark-1', 'x-bookmark-2', 'x-bookmark-3']);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.authorization === `Bearer ${TOKEN}`));
  assert.match(calls[0].address, /\/users\/me$/);
  assert.match(calls[1].address, /\/users\/u1\/bookmarks\?/);
  assert.match(calls[1].address, /tweet\.fields=[^&]*entities/);
  assert.match(calls[1].address, /expansions=[^&]*referenced_tweets\.id/);
  assert.doesNotMatch(calls[1].address, /pagination_token/);
  assert.match(calls[2].address, /pagination_token=next-1/);
});

test('likes use the liked_tweets path and the read stops after several pages of posts the person already has', async () => {
  const quiet = n => ({ body: page([tweet(`k${n}`, 'kept')], `t${n}`) });
  const { calls, fetchImpl } = standIn([me, quiet(1), quiet(2), quiet(3), quiet(4)]);
  const collected = collector(['k1', 'k2', 'k3', 'k4']);
  const pages = await readFromApi({ which: 'likes', token_fd: 3 }, collected, { fetchImpl, read });
  assert.equal(pages, 3);
  assert.match(calls[1].address, /\/users\/u1\/liked_tweets\?/);
  assert.equal(calls.length, 4);
});

test('every refusal ends the run with X\'s words, what they usually mean, and never the token', async () => {
  for (const [status, words, meaning] of [[401, 'Unauthorized', /expired or was revoked/], [403, 'Forbidden', /plan for this app/], [429, 'Too Many Requests', /limiting reads/]]) {
    const { fetchImpl } = standIn([{ status, body: { title: words, detail: words }, headers: { 'x-rate-limit-reset': '1790000000' } }]);
    await assert.rejects(readFromApi({ which: 'bookmarks', token_fd: 3 }, collector([]), { fetchImpl, read }), error => {
      assert.match(error.message, new RegExp(`${status} ${words}`));
      assert.match(error.message, meaning);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  }
});

test('an answer that is not JSON and an identity with no id are refused, not read as empty', async () => {
  await assert.rejects(readFromApi({ which: 'bookmarks', token_fd: 3 }, collector([]), { fetchImpl: standIn([{ body: 'oops' }]).fetchImpl, read }), /not JSON/);
  await assert.rejects(readFromApi({ which: 'bookmarks', token_fd: 3 }, collector([]), { fetchImpl: standIn([{ body: { data: {} } }]).fetchImpl, read }), /has no id/);
});

test('a way that does not exist is refused', async () => {
  await assert.rejects(readSaved({ via: 'carrier-pigeon', which: 'bookmarks' }), /via must be one of api, browser/);
});
