// src/claimed-time.mjs
// The one check of a time someone else gives this service (when a message was written, when an email went out): read
// once where it arrives, so every reader after it holds an exact time it can order by.
//
// Invariants:
// - A given time is a date and time (anything Date.parse reads), kept as its exact ISO form.
// - It may be any time in the past (an earlier chat brought in later), and at most `ahead_seconds` (claimed-time.json)
//   ahead of this service's clock: a computer whose clock runs fast never dates a message into the future, where it
//   would stay first in every newest-first read.
// - The service's own clock is the reference; a caller's clock never moves it.

import rules from './claimed-time.json' with { type: 'json' };

export const AHEAD_SECONDS = rules.ahead_seconds;

/** The given time as an exact ISO time, or the reason it cannot be used, in words naming `field`. */
export function claimedTimeProblem(value, { now = new Date(), field = 'at' } = {}) {
  const time = typeof value === 'string' || value instanceof Date ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(time.getTime())) return { problem: `${field} must be a date and time, like 2026-09-27T17:13:00Z` };
  if (time.getTime() - now.getTime() > AHEAD_SECONDS * 1000) return { problem: `${field} is ${time.toISOString()}, later than now (${now.toISOString()}); a time that has not happened yet cannot be kept. Leave it out to use the time it arrives.` };
  return { at: time.toISOString() };
}

/** The given time as an exact ISO time; throws `make(problem)` when it cannot be used. */
export function claimedTime(value, { now, field, make = message => new Error(message) } = {}) {
  const { at, problem } = claimedTimeProblem(value, { now, field });
  if (problem) throw make(problem);
  return at;
}
