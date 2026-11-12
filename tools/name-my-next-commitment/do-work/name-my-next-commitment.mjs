// tools/name-my-next-commitment/do-work/name-my-next-commitment.mjs
//
// tool:name-my-next-commitment, run as a function in the tool container:
//
//   node do-work/name-my-next-commitment.mjs < <the input as JSON>
//
// and prints { result } on its last line (or { error } with exit 1). It is the line the Mac menu bar item shows when
// nothing is running: the timed calendar item happening now or next inside the person's reach, with its countdown.
// The caller reads the calendar items from the person's records and hands them over; nothing is read or kept here.
//
// Input: { items: [{ id?, title?, source?, starts_at, ends_at?, all_day? }], now?, within_hours?, counting? }
//   now           the time to count from (ISO); the clock when left out
//   within_hours  how far ahead counts (0 = the rest of today); the words' default when left out
//   counting      { [source]: 'within' | 'always' | 'never' }: how each calendar's items count; 'within' when left out
// Answer: { line, within_hours, reach_ends_at, look_ahead_minutes, refresh_seconds }; the look-ahead is how far the caller
// reads the calendar, the refresh how often it asks again.
import { readFileSync } from 'node:fs';
import { nextCommitment, reach } from '../read-data/next-commitment.ts';
import words from '../read-data/next-commitment.json' with { type: 'json' };

const COUNTING = ['within', 'always', 'never'];

export function nameMyNextCommitment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send one JSON object: { items, now?, within_hours?, counting? }.');
  if (!Array.isArray(input.items) || !input.items.every(item => item && typeof item === 'object' && typeof item.starts_at === 'string')) {
    throw new Error('items is a list of calendar items, each with starts_at (an ISO time), and optionally title, source, ends_at and all_day.');
  }
  const nowMs = input.now === undefined ? Date.now() : Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error('now is an ISO time; leave it out for the clock.');
  const withinHours = input.within_hours === undefined ? words.default_within_hours : input.within_hours;
  if (!Number.isInteger(withinHours) || withinHours < 0) throw new Error('within_hours is a whole number of hours, 0 for the rest of today.');
  const counting = input.counting ?? {};
  if (typeof counting !== 'object' || Array.isArray(counting) || !Object.values(counting).every(how => COUNTING.includes(how))) {
    throw new Error("counting maps each calendar source to 'within', 'always' or 'never'.");
  }
  const line = nextCommitment(input.items, nowMs, withinHours, item => counting[item.source] ?? 'within');
  return {
    line,
    within_hours: withinHours,
    reach_ends_at: new Date(reach(nowMs, withinHours)).toISOString(),
    look_ahead_minutes: words.look_ahead_minutes,
    refresh_seconds: words.refresh_seconds,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try {
    process.stdout.write(JSON.stringify({ result: nameMyNextCommitment(JSON.parse(readFileSync(0, 'utf8') || '{}')) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
