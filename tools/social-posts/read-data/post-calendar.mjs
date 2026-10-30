// tools/social-posts/read-data/post-calendar.mjs
//
// The posts on a calendar between two times, read from the person's own `post` records through the run's records
// door (tools/records-door). Each post is at its scheduled time, or, sent without one, when sending began; a draft or
// approved post with neither is unscheduled. Each post says whether it can still be moved.
import settings from './post-calendar.json' with { type: 'json' };

export const KIND = 'post';
const DAY_MS = 86_400_000;
const APPROVAL_FIELDS = ['caption', 'media', 'caption_by_platform', 'settings_by_platform', 'destinations', 'link', 'scheduled_for', 'time_zone', 'source', 'format_id', 'reaches'];
const approvalValues = post => Object.fromEntries(APPROVAL_FIELDS.map(field => [field, post[field] ?? null]));

// A post that can still change: a draft, an approved post, or one set for later that nothing was sent for yet.
const changeable = post => ['draft', 'approved'].includes(post.status) || (post.status === 'scheduled' && !post.sent_at && !Object.keys(post.deliveries ?? {}).length);

// A post as every reader sees it.
function shaped(post) {
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

/** tool:read-post-calendar: the posts between `from` and `to`, earliest first, and the unscheduled ones, newest first. */
export async function readPostCalendar({ from, to } = {}, { door }) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('from and to are dates and times with their zone, from before to, like 2026-10-01T00:00:00-04:00 and 2026-11-01T00:00:00-04:00.');
  if (end - start > settings.calendar_max_days * DAY_MS) throw new Error(`A calendar read covers at most ${settings.calendar_max_days} days; read a shorter span.`);
  const at = post => post.scheduled_for ?? post.sent_at ?? null;
  // The door lists a kind greatest id first, so the newest posts come first.
  const every = [];
  for await (const record of door.list({ type: KIND })) if (record.value) every.push(record.value);
  const onIt = every.filter(post => { const time = Date.parse(at(post)); return time >= start && time < end; }).sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)));
  const unscheduled = every.filter(post => !at(post) && ['draft', 'approved'].includes(post.status)).slice(0, settings.list_limit);
  const shown = post => ({ ...shaped(post), at: at(post), can_move: changeable(post) });
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), posts: onIt.map(shown), unscheduled: unscheduled.map(shown) };
}
