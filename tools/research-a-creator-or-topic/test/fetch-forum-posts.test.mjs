// tools/research-a-creator-or-topic/test/fetch-forum-posts.test.mjs
//
// tool:keep-forum-posts-from-a-public-archive (do-work/fetch_forum_posts.py) against a made-up archive: test/stand-in/
// forum_archive.py stands in for urllib's urlopen and runs the script as the row does. Every forum and post is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const runner = join(folder, 'test', 'stand-in', 'forum_archive.py');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload)
  .find(payload => payload.id === 'tool:keep-forum-posts-from-a-public-archive');
const API = 'https://arctic-shift.photon-reddit.com/api/posts/search';
const at = (forum, before) => `${API}?subreddit=${forum}&limit=100&sort=desc${before ? `&before=${before}` : ''}`;
const post = (id, created) => ({ id, permalink: `/r/baking/comments/${id}/`, title: `Why does my dough ${id} rise?`, selftext: '', score: 5, num_comments: 2, created_utc: created, author: 'dropped' });

function run(request, plan) {
  const work = mkdtempSync(join(tmpdir(), 'forum-posts-'));
  writeFileSync(join(work, 'plan.json'), JSON.stringify(plan));
  const out = spawnSync('python3', [runner, join(work, 'plan.json'), join(work, 'calls.jsonl')], {
    cwd: work, input: JSON.stringify(request), encoding: 'utf8', env: { ...process.env, FORUM_POSTS_WAIT_SECONDS: '0' },
  });
  const read = name => existsSync(join(work, name)) ? readFileSync(join(work, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { status: out.status, stderr: out.stderr, last: JSON.parse(out.stdout.trim().split('\n').pop()), calls: read('calls.jsonl'), kept: read('out/forum-posts.jsonl') };
}

const plan = {
  [at('baking')]: { body: { data: [post('a1', 300), post('a2', 200)] } },
  [at('baking', 200)]: { body: { data: [post('a3', 100)] } },
  [at('bread')]: { status: 503 },
};

test('each forum is read page by page, each page older than the last, keeping only the archive fields named', () => {
  const { status, last, calls, kept } = run({ forums: { baking: 'home-bakers', bread: 'bread-people' }, pages: 3 }, plan);
  assert.equal(status, 0);
  assert.deepEqual(calls.map(call => call.address), [at('baking'), at('baking', 200), at('baking', 100), at('bread'), at('bread'), at('bread'), at('bread')]);
  assert.equal(calls[0].agent, 'viewer-question-research/1.0');
  assert.deepEqual(last.result.forums, [{ forum: 'baking', posts: 3, pages: 2, finished: true }, { forum: 'bread', posts: 0, pages: 0, finished: true }]);
  assert.deepEqual(last.result.failed, [{ forum: 'bread', reason: 'the archive did not answer after 4 tries' }]);
  assert.equal(last.result.again, null);
  assert.deepEqual(kept.map(line => line.id), ['a1', 'a2', 'a3']);
  assert.deepEqual(Object.keys(kept[0]).sort(), ['created_utc', 'forum', 'group', 'id', 'num_comments', 'permalink', 'score', 'selftext', 'title']);
  assert.equal(kept[0].group, 'home-bakers');
});

test('a list of names or {name, group} is read too, and progress continues where a forum stopped', () => {
  const { last, calls, kept } = run({ forums: [{ name: 'baking', group: 'home-bakers' }], pages: 2, progress: { baking: { before: 200, pages: 1 } } }, plan);
  assert.deepEqual(calls.map(call => call.address), [at('baking', 200)]);
  assert.deepEqual(kept.map(line => line.id), ['a3']);
  assert.deepEqual(last.result.forums, [{ forum: 'baking', posts: 1, pages: 2, finished: true }]);
});

test('a request it cannot read is refused with what to send', () => {
  for (const [request, words] of [
    [{ forums: [] }, /forums is 1 to 100 forums/],
    [{ forums: ['no spaces here'] }, /A forum is its name/],
    [{ forums: ['baking'], pages: 99 }, /pages is a whole number from 1 to 20/],
    [{ forums: ['baking'], extra: 1 }, /Unknown input: extra/],
  ]) {
    const { status, last, calls } = run(request, plan);
    assert.equal(status, 2);
    assert.match(last.error, words);
    assert.equal(calls.length, 0, 'nothing is asked before the request is read whole');
  }
});

test('the row runs this file from its own folder and keeps the file it writes', () => {
  assert.deepEqual(row.invoke.argv, ['python3', '/opt/research-a-creator-or-topic/do-work/fetch_forum_posts.py']);
  assert.equal(row.invoke.workdir, '/opt/research-a-creator-or-topic');
  assert.equal(row.invoke.outputs[0].path, '/opt/research-a-creator-or-topic/out/forum-posts.jsonl');
  assert.equal(row.invoke.internet, true);
  assert.equal(row.verify[0].replies[0].request.url, at('baking'));
});
