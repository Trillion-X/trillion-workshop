// src/workspace/next-commitment.ts
//
// Purpose
//   The line the Mac menu bar item shows when nothing is running: the Calendar item happening now or next, with a
//   countdown ("Design review · in 12 min"). Pure; the words are DATA (next-commitment.json).
//
// Non-negotiable invariants
//   1. Only timed items count: an all-day item is not a commitment at a time.
//   2. An item that has started and not ended is "now"; otherwise the earliest start inside the person's chosen reach
//      (`withinHours`: hours ahead, 0 for the rest of today only) wins.
//   3. The line is built from the item's own title; an item with no title is skipped, never shown blank.
//   4. A calendar can be told to count `never` (its items are skipped), `always` (its items count however far off they
//      are, within the look-ahead) or `within` (the person's reach, the default); the caller says which for each item.
import words from './next-commitment.json' with { type: 'json' };

export interface CommitmentItem { id?: string; title?: string | null; source?: string; starts_at: string; ends_at?: string | null; all_day?: boolean }
export type CommitmentCounting = 'within' | 'always' | 'never';

const fill = (template: string, facts: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (_, name) => String(facts[name] ?? ''));

/** The countdown to `startMs` from `nowMs`: "now" once started, then minutes, then hours. */
export function countdown(startMs: number, nowMs: number): string {
  const minutes = Math.ceil((startMs - nowMs) / 60_000);
  if (minutes <= 0) return words.when.now;
  if (minutes < 60) return fill(words.when.minutes, { minutes });
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest === 0 ? fill(words.when.hours, { hours }) : fill(words.when.hours_minutes, { hours, minutes: rest });
}

/** How far ahead a commitment counts: `withinHours` hours from `nowMs`, or the end of the local day when it is 0. */
export function reach(nowMs: number, withinHours: number): number {
  const widest = nowMs + words.look_ahead_minutes * 60_000;
  if (withinHours > 0) return Math.min(nowMs + withinHours * 3_600_000, widest);
  const midnight = new Date(nowMs);
  midnight.setHours(24, 0, 0, 0);
  return Math.min(midnight.getTime(), widest);
}

/** The line for the commitment now or next, or null when there is none inside the reach. */
export function nextCommitment(items: readonly CommitmentItem[], nowMs: number, withinHours: number = words.default_within_hours, counting: (item: CommitmentItem) => CommitmentCounting = () => 'within'): string | null {
  const horizon = reach(nowMs, withinHours);
  const widest = nowMs + words.look_ahead_minutes * 60_000;
  let best: { start: number; title: string } | null = null;
  for (const item of items) {
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const start = Date.parse(item.starts_at), end = item.ends_at ? Date.parse(item.ends_at) : start;
    const how = counting(item);
    if (how === 'never' || !title || item.all_day || !Number.isFinite(start) || start >= (how === 'always' ? widest : horizon) || end <= nowMs) continue;
    const effective = Math.max(start, nowMs);
    if (!best || effective < best.start) best = { start: effective, title };
  }
  return best ? fill(words.line, { what: best.title, when: countdown(best.start, nowMs) }) : null;
}
