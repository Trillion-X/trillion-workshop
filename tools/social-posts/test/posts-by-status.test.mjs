// Listing a person's posts by status. Made-up records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listPostsByStatus, POST_STATUSES } from '../read-data/posts-by-status.mjs';

const record = (post_id, status, extra = {}) => ({ id: post_id, type: 'post', value: { post_id, status, caption: `Post ${post_id}`, ...extra } });

test('only the posts with the asked status are listed, earliest scheduled first', () => {
  const records = [
    record('post:b', 'scheduled', { scheduled_for: '2099-06-02T09:00:00Z' }),
    record('post:a', 'scheduled', { scheduled_for: '2099-06-01T09:00:00Z' }),
    record('post:c', 'draft'),
    record('post:d', 'posted', { scheduled_for: '2099-05-01T09:00:00Z' }),
  ];
  const scheduled = listPostsByStatus(records, 'scheduled');
  assert.deepEqual(scheduled.map(post => post.post_id), ['post:a', 'post:b']);
  assert.equal(scheduled[0].status, 'scheduled');
  assert.deepEqual(listPostsByStatus(records, 'draft').map(post => post.post_id), ['post:c']);
});

test('a status outside the list is refused, and records that are not posts are skipped', () => {
  assert.throws(() => listPostsByStatus([], 'sent'), /Choose a status/);
  assert.deepEqual(listPostsByStatus([{ id: 'x', type: 'connection', value: { status: 'draft' } }, null, { type: 'post' }], 'draft'), []);
  assert.deepEqual(POST_STATUSES, ['draft', 'approved', 'scheduled', 'posted', 'failed']);
});
