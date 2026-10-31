// tool:see-how-each-post-did run as the container runs it, against the fake records door with exactly the row's rights.
// All posts, ids, addresses and numbers are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rowOf(rows, 'tool:see-how-each-post-did');
const post = (n, fields) => ({ id: `post:p${n}`, type: 'post', value: { post_id: `p${n}`, caption: `Post ${n}\nmore words`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...fields } });
const records = [
  post(1, { status: 'posted', sent_at: '2026-10-05T10:00:00Z', destinations: ['a'], deliveries: { a: { platform: 'place-one', status: 'posted', url: 'https://place-one.example/1', platform_post_id: 'remote-1' } } }),
  post(2, { status: 'posted', destinations: ['a', 'b'], deliveries: { a: { platform: 'place-one', status: 'posted', platform_post_id: 'remote-2a' }, b: { platform: 'place-two', status: 'posted', platform_post_id: 'remote-2b' } } }),
  post(3, { status: 'failed', destinations: ['a'], deliveries: { a: { platform: 'place-one', status: 'failed', error: 'refused' } } }),
  post(4, { status: 'draft' }),
];

test('a place\'s counts, the visits its link brought and their sales come back per published place', async () => {
  const ran = await runRow(row, {
    observations: [{ post_id: 'p1', account_id: 'a', metrics: { views: 712, shares: 9 }, observed_at: '2026-10-07T12:00:00Z' }, { platform_post_id: 'remote-2b', account_id: 'b', metrics: { views: 40 } }],
    visits: [
      { visitor: 'v1', project: 'site', signals: { utm_content: 'p1' } },
      { visitor: 'v2', project: 'site', signals: { utm_content: 'remote-1' } },
      { visitor: 'v3', project: 'site', signals: { utm_content: 'p2' } },
      { visitor: 'v4', project: 'site', signals: { utm_content: 'p2::b' } },
    ],
    conversions: [{ visitor: 'v1', project: 'site', value: 45 }, { visitor: 'v4', project: 'site', value: 10 }],
  }, { records });
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.places_published, 3);
  const byPlace = Object.fromEntries(ran.result.posts.map(item => [`${item.post_id}:${item.account_id}`, item]));
  assert.deepEqual(Object.keys(byPlace).sort(), ['p1:a', 'p2:b']);
  assert.deepEqual(byPlace['p1:a'].metrics, { views: 712, shares: 9 });
  assert.deepEqual(byPlace['p1:a'].brought, { visits: 2, conversions: 1, value: 45 });
  assert.equal(byPlace['p1:a'].title, 'Post 1');
  assert.equal(byPlace['p1:a'].url, 'https://place-one.example/1');
  // p2 went to two places: its bare token names neither, so only the per-place token counts.
  assert.deepEqual(byPlace['p2:b'].brought, { visits: 1, conversions: 1, value: 10 });
  assert.deepEqual(byPlace['p2:b'].metrics, { views: 40 });
});

test('post_ids narrows the posts, and nothing counted gives no row rather than zeros', async () => {
  const ran = await runRow(row, { post_ids: ['p2'], visits: [{ visitor: 'v1', signals: { utm_content: 'p1' } }] }, { records });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.result.posts, []);
  assert.equal(ran.result.places_published, 2);
});

test('an observation that names no post is refused with what to give', async () => {
  const ran = await runRow(row, { observations: [{ metrics: { views: 1 } }] }, { records });
  assert.equal(ran.status, 1);
  assert.match(ran.error, /post_id with account_id, or platform_post_id/);
});

test('the row only lists post records', () => {
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'post', operations: ['records:list'] }]);
});
