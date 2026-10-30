// tools/social-posts/read-data/post-calendar.mjs
//
// The posts on a calendar between two times, read from the person's own `post` records through the run's records
// door (tools/records-door). Each post is at its scheduled time, or, sent without one, when sending began; a draft or
// approved post with neither is unscheduled. Each post says whether it can still be moved.
import settings from './post-calendar.json' with { type: 'json' };
import { KIND, changeable, shaped } from './post-shape.mjs';

const DAY_MS = 86_400_000;

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
