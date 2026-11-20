// tools/save-what-you-watch-and-read/test/save-x-posts.test.mjs: tool:save-x-bookmarks and tool:save-x-likes keep the
// person's saved X posts as one saved-links file, and answer how many are new and the newest key. The X reader is stubbed
// with a page of made-up posts; the folder is a temporary one that the test removes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveXPosts } from '../do-work/save-x-posts.mjs';

const post = key => ({ key, url: `https://x.example/${key}`, title: `post ${key}`, author: 'sample_maker', author_name: 'Sample Maker', posted_at: '2026-09-02T16:50:26Z' });
const page = keys => async (request, collected) => { collected.onPage(keys.map(post)); return 1; };

test('the bookmarks are kept as one file, newest first, and the answer names the newest key', async () => {
  const out = mkdtempSync(join(tmpdir(), 'save-x-'));
  try {
    const answer = await saveXPosts({ which: 'bookmarks', account: 'service_connection:x' }, { out, way: page(['9', '5', '2']) });
    assert.equal(answer.newest, '9');
    assert.equal(answer.total, 3);
    assert.equal(answer.file, 'saved-x-bookmarks.json');
    const kept = JSON.parse(readFileSync(join(out, answer.file), 'utf8'));
    assert.equal(kept.saved_from, 'X');
    assert.deepEqual(kept.posts.map(p => p.key), ['9', '5', '2']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the likes go to their own file, and a since the list already holds counts nothing as new', async () => {
  const out = mkdtempSync(join(tmpdir(), 'save-x-'));
  try {
    const answer = await saveXPosts({ which: 'likes', account: 'service_connection:x', since: '5' }, { out, way: page(['9', '5', '2']) });
    assert.equal(answer.file, 'saved-x-likes.json');
    assert.equal(answer.not_kept_yet, 2, 'the since post is kept, so 9 and 2 are the new ones');
    assert.ok(existsSync(join(out, 'saved-x-likes.json')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a list other than bookmarks or likes is refused and writes no file', async () => {
  const out = mkdtempSync(join(tmpdir(), 'save-x-'));
  try {
    await assert.rejects(saveXPosts({ which: 'followers', account: 'service_connection:x' }, { out, way: page([]) }), /which must be bookmarks or likes/);
    assert.equal(existsSync(join(out, 'saved-x-followers.json')), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
