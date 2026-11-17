// tools/share-anything/read-data/access-ends-when-unused.mjs
//
// Purpose: The one owner of how long a grant of the person's access may go unused (access-ends-when-unused.json `unused_days`)
// and of the condition row every grant is written with: `{ grant, unused_days, since, ends_at? }`, kind data.run.end_kind of
// share-anything.json. The rule is a row the person holds, never engine code (decision case
// source:bm8tZ3JhbnQtY29uZGl0aW9uLWluLWVuZ2luZS1jb2RlOndoZXJlLWNvbmRpdGlvbnMtbGl2ZS0yMDI2LTExLTE2): the grant tool copies the
// default into the row at the moment of the grant, the person may edit or remove the row, and a wake the person switched on
// (tool:end-shares-whose-condition-failed) withdraws the grant when the row says it has ended.
//
//   unusedDays, unusedSeconds, unusedMs   the default window; Better Auth's refreshTokenExpiresIn is unusedSeconds
//   checkEveryMs                          how often the sweep wakes, derived from the window (check_window_fraction)
//   conditionOf({ grant, at, endsAt })    the row a new grant is written with
//   endOf(condition, lastUsedAt)          { at, reason } when the row ends the grant, else null; `at` is milliseconds
//   endedRecord(...)                      what the sweep keeps when it withdraws
//
// Non-Negotiable Invariants:
// - Each use starts the days again: the end is the later of `since` (the grant) and the last use, plus unused_days.
// - A row without `unused_days` holds no unused rule (the person removed it); a row without `ends_at` holds no fixed end.
//   Nothing here fills either back in.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import rule from './access-ends-when-unused.json' with { type: 'json' };

const DAY_MS = 86_400_000;

export const unusedDays = rule.unused_days;
export const unusedSeconds = unusedDays * 86_400;
export const unusedMs = unusedDays * DAY_MS;
export const checkEveryMs = Math.round(unusedMs * rule.check_window_fraction);
export const ended = { kind: rule.ended_kind, prefix: rule.ended_prefix };
export const words = rule.words;

export function conditionOf({ grant, at, endsAt }) {
  return { grant, unused_days: unusedDays, since: at, ...(endsAt === undefined ? {} : { ends_at: endsAt }) };
}

const timeOf = value => (typeof value === 'string' ? Date.parse(value) : NaN);

/**
 * When `condition` ends its grant, given the grant's last use as the engine lists it: an ISO time, null for never used, or
 * undefined when the engine answers no last use at all (then only the fixed end is read, and the caller says so). The earlier
 * of the fixed end and the unused end.
 */
export function endOf(condition, lastUsedAt) {
  const ends = [];
  const fixed = timeOf(condition.ends_at);
  if (Number.isFinite(fixed)) ends.push({ at: fixed, reason: 'end-passed' });
  const days = condition.unused_days;
  const since = timeOf(condition.since);
  if (lastUsedAt !== undefined && typeof days === 'number' && days > 0 && Number.isFinite(since)) {
    const used = timeOf(lastUsedAt);
    ends.push({ at: Math.max(since, Number.isFinite(used) ? used : since) + days * DAY_MS, reason: 'unused' });
  }
  return ends.length ? ends.reduce((first, next) => (next.at < first.at ? next : first)) : null;
}

export const endedRecord = ({ grant, at, reason, days }) => ({ grant, ended_at: new Date(at).toISOString(), reason, unused_days: days });
