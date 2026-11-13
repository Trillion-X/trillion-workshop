// src/workspace/last-run-words.mjs
//
// PURPOSE
//   How one automation's last run reads on the Automations screen, in its list and in its own tab: "Running now" while
//   a Run now press is on its way, "Ran just now" for a minute after a run, then the date it ran; a press that could not
//   run reads "Could not run just now: <why>" (or "on <date>"), in the refusal's own words, which the store keeps as the
//   last run (src/automations.mjs runNow).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One owner for these words and for how a date is written on that screen (dateText); the screen imports both.
//   2. Nothing to say (never run, not running) is the empty string, so the list shows its own blank.

const JUST_NOW_MS = 60_000;

/** A date and time as the Automations screen writes it ("Sep 30, 2026, 5:38 AM"), or '' when there is none. */
export const dateText = value => (value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** What one automation's last run says: { at, problem?, running? } → words; `now` is the clock it is read against. */
export function lastRunWords({ at, problem = null, running = false }, now = Date.now()) {
  if (running) return 'Running now';
  if (!at) return '';
  const recent = now - Date.parse(at) < JUST_NOW_MS;
  if (problem) return `Could not run ${recent ? 'just now' : `on ${dateText(at)}`}: ${problem}`;
  return recent ? 'Ran just now' : dateText(at);
}
