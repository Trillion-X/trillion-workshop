// tools/social-posts/read-data/post-shape.mjs
//
// The one shape every reader and writer of the person's `post` records sees a post in: which fields the person
// approves (everything that goes out), whether a post can still change, and the post as a reader is shown it.
// Every tool in this folder imports it, so a post reads the same from the calendar, a draft or a check.

export const KIND = 'post';
// What a person approves: everything that goes out. Saving the same content again is not a change.
export const APPROVAL_FIELDS = ['caption', 'media', 'caption_by_platform', 'settings_by_platform', 'destinations', 'link', 'scheduled_for', 'time_zone', 'source', 'format_id', 'reaches'];
export const approvalValues = post => Object.fromEntries(APPROVAL_FIELDS.map(field => [field, post[field] ?? null]));
export const contentOf = post => JSON.stringify(APPROVAL_FIELDS.map(field => post[field] ?? null));

// A post that can still change: a draft, an approved post, or one set for later that nothing was sent for yet.
export const changeable = post => ['draft', 'approved'].includes(post.status) || (post.status === 'scheduled' && !post.sent_at && !Object.keys(post.deliveries ?? {}).length);

// A post as every reader sees it.
export function shaped(post) {
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
    ...(post.armed_at ? { armed_at: post.armed_at } : {}),
  };
}
