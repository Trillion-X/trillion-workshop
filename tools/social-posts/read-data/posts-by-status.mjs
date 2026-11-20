// tools/social-posts/read-data/posts-by-status.mjs
//
// A person's posts listed by status (draft, approved, scheduled, posted, failed), from the post records the caller hands in as
// { id, type: 'post', value }. Pure: it reads no store and changes nothing. The statuses are the ones the posting code keeps
// (read-data/native-post-lifecycle.mjs). Built and tested; no tool row yet (build-and-hold: nothing calls it).
export const POST_STATUSES = Object.freeze(['draft', 'approved', 'scheduled', 'posted', 'failed']);

const timeOf = post => Date.parse(post.scheduled_for ?? post.updated_at ?? '') || 0;

/** The posts whose status is `status` (one of POST_STATUSES), earliest scheduled first, newest updated last among those without a time. */
export function listPostsByStatus(records, status) {
  if (!POST_STATUSES.includes(status)) throw new Error(`Choose a status: ${POST_STATUSES.join(', ')}.`);
  const posts = (Array.isArray(records) ? records : [])
    .filter(record => record?.type === 'post' && record.value && typeof record.value === 'object')
    .map(record => record.value)
    .filter(post => post.status === status)
    .map(post => ({ post_id: post.post_id ?? null, status: post.status, scheduled_for: post.scheduled_for ?? null, caption: post.caption ?? '' }));
  return posts.sort((left, right) => timeOf(left) - timeOf(right) || String(left.post_id).localeCompare(String(right.post_id)));
}

/** The entry tool:list-posts-by-status calls: { records, status } in, { posts } out. Read-only; changes nothing. */
export function listForInput(input) {
  return { posts: listPostsByStatus(input?.records, input?.status) };
}
