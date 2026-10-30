// tool:read-post-calendar run as the container runs it, against the fake records door with exactly the row's rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rowOf(rows, 'tool:read-post-calendar');
const post = (n, fields) => ({ id: `post:p${n}`, type: 'post', value: { post_id: `p${n}`, caption: `Post ${n}`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...fields } });
const records = [
  post(1, { status: 'scheduled', scheduled_for: '2026-10-20T09:00:00Z' }),
  post(2, { status: 'posted', sent_at: '2026-10-05T10:00:00Z', deliveries: { a: { platform: 'x', url: 'https://x.example/1', status: 'posted' } }, destinations: ['a'] }),
  post(3, { status: 'draft' }),
  post(4, { status: 'approved' }),
  post(5, { status: 'scheduled', scheduled_for: '2026-12-01T09:00:00Z' }),
  post(6, { status: 'posted' }),
];

test('posts in the span come earliest first with whether each can move, and unscheduled drafts newest first', async () => {
  const ran = await runRow(row, { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }, { records });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.result.posts.map(item => [item.post_id, item.at, item.can_move]), [['p2', '2026-10-05T10:00:00Z', false], ['p1', '2026-10-20T09:00:00Z', true]]);
  assert.deepEqual(ran.result.posts[0].platform_urls, { x: 'https://x.example/1' });
  assert.deepEqual(ran.result.posts[0].destinations, [{ account_id: 'a', platform: 'x', url: 'https://x.example/1', status: 'posted' }]);
  assert.deepEqual(ran.result.unscheduled.map(item => item.post_id), ['p4', 'p3']);
  assert.equal(ran.result.from, '2026-10-01T00:00:00.000Z');
});

test('a span that is backwards or longer than the limit is refused with what to give', async () => {
  const backwards = await runRow(row, { from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' });
  assert.equal(backwards.status, 1);
  assert.match(backwards.error, /from before to/);
  assert.match((await runRow(row, { from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).error, /at most 400 days/);
});

test('the row only lists post records', () => {
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'post', operations: ['records:list'] }]);
});
