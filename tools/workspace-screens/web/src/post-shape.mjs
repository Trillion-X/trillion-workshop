// src/post-shape.mjs
//
// PURPOSE
//   One post as it is shown: the kept post record (record type `post`, src/social-posts.json record_type) shaped for a
//   reader. The posts store (src/social-posts.mjs) answers its reads with it, and the page's Posts screen
//   (src/workspace/posts-screen.tsx) shapes the post records it reads through the records door with it, so the two
//   never show a post differently.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: the record's value in, the shown post out; nothing is read or kept here.
//   2. A delivery's own reference and attempt never leave the record (they are the publisher's, not the reader's).

// What a person approves: everything that goes out.
export const APPROVAL_FIELDS = ['caption', 'media', 'caption_by_platform', 'settings_by_platform', 'destinations', 'link', 'scheduled_for', 'time_zone', 'source', 'format_id', 'reaches'];
export const approvalValues = post => Object.fromEntries(APPROVAL_FIELDS.map(field => [field, post[field] ?? null]));

/** The post a reader is shown, from its kept record value. */
export function shapePost(post) {
  const deliveries = post.deliveries ?? {};
  return {
    post_id: post.post_id, status: post.status,
    approval_values: approvalValues(post),
    media: post.media ?? null, caption: post.caption ?? '', caption_by_platform: post.caption_by_platform ?? {}, settings_by_platform: post.settings_by_platform ?? {},
    source: post.source ?? null, format_id: post.format_id ?? null, caption_style_check: post.caption_style_check ?? null, reaches: post.reaches ?? [], ...(post.grounded ? { grounded: post.grounded } : {}),
    link: post.link ?? null, scheduled_for: post.scheduled_for ?? null, ...(post.hold_seconds ? { hold_seconds: post.hold_seconds } : {}), ...(post.held_until ? { held_until: post.held_until } : {}), ...(post.abort_on_reply ? { abort_on_reply: post.abort_on_reply } : {}), ...(post.edited_by_person_at ? { edited_by_person_at: post.edited_by_person_at, drafted_by: post.drafted_by ?? null } : {}), ...(post.cancelled_because ? { cancelled_because: post.cancelled_because } : {}), time_zone: post.time_zone ?? null, sent_at: post.sent_at ?? null,
    destinations: (post.destinations ?? []).map(accountId => {
      const { delivery_ref: _ref, attempt: _attempt, ...shown } = deliveries[accountId] ?? { status: 'not sent' };
      return { account_id: accountId, ...shown };
    }),
    platform_urls: Object.fromEntries(Object.values(deliveries).filter(item => item.url).map(item => [item.platform, item.url])),
    errors: Object.values(deliveries).filter(item => item.error).map(item => ({ platform: item.platform, said: item.error })),
    created_at: post.created_at, updated_at: post.updated_at, ...(post.approved_at ? { approved_at: post.approved_at, approved_by: post.approved_by ?? null } : {}),
  };
}
