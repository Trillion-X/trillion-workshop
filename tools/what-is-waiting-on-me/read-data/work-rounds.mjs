// src/work-rounds.mjs
//
// Purpose
//   Work that runs in rounds (a shelf test, a weekly check, any step tried again until it is right) is never forced to
//   a false "done". A Waiting on you row that carries a round step (src/waiting-on-you.json `rounds`) finishes only this
//   round's step: what the round showed is kept in the row's round log, the round is counted, and the next round's step
//   opens as the new step, so the same row waits again with its measured progress (the list `progress` field kind,
//   src/work-progress.mjs) instead of closing.
//
// Non-negotiable invariants
//   1. Which fields hold the step, the count, the plan, the log and the next step, and the words of a log line, are DATA
//      (`rounds` in src/waiting-on-you.json); nothing here names a row, a product or a test.
//   2. A row is in rounds only when its step field holds words; every other row finishes the way it always did.
//   3. Finishing a round never sets the row's done status: it counts the round, appends what it showed (the person's or
//      the check's own words, or `rounds.showed_unsaid` when none were given) and opens the next step. When the plan
//      (`planned_field`) is reached, the row is done the ordinary way, because then it truly is.
//   4. The round restarts the row's waiting time (`starts_field`), so the next round holds the page only once it has
//      waited like any new thing.
//

const words = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const count = value => (Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** Whether this row's values are work that runs in rounds (invariant 2). */
export const inRounds = (values, rules) => Boolean(rules && words(values?.[rules.step_field]));

/** The values that finish this round of `values` (invariant 3), or null when the plan is reached and the row is done. */
export function nextRound(values, { showed, at = new Date().toISOString() } = {}, rules) {
  if (!inRounds(values, rules)) return null;
  const done = count(values[rules.done_field]) + 1;
  const planned = count(values[rules.planned_field]);
  const line = fill(rules.log_line, { round: done, step: words(values[rules.step_field]), showed: words(showed) ?? rules.showed_unsaid, at: at.slice(0, 10) });
  const log = [words(values[rules.log_field]), line].filter(Boolean).join('\n');
  const base = { [rules.done_field]: done, [rules.log_field]: log };
  if (planned && done >= planned) return { ...base, finished: true };
  return { ...base, [rules.step_field]: words(values[rules.next_field]) ?? words(values[rules.step_field]), [rules.next_field]: null, [rules.starts_field]: at, finished: false };
}
