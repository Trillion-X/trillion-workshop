// src/loop-guards.mjs
//
// Purpose: keeps a model that works a job in a loop from spinning. After each tool call it answers whether to nudge the
// model, give the job back, or go on. Used by the model loop of the person's own AIs (src/own-ais-work.mjs).
//
// Non-negotiable invariants
//   1. Every number and every word is DATA (src/own-ais.json `loop_guards`); nothing here names a tool or a model.
//   2. A call is counted by its name and its arguments in canonical form (key order never matters): the same call again
//      in a row is a repeat, any different call ends the run of repeats.
//   3. A malformed call (arguments that were not JSON, a tool the agent may not call) is the model's slip, not the
//      tool's failure: it never counts against the error budget, and it does not break a run of repeats.
//   4. Failures count only in a row: one success clears them. When the budget is spent the job is given back with the
//      reason said, never retried silently.
//   5. A nudge is said once per run of repeats, at the step the data names, so the model is not nagged every turn.

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

/**
 * rules: src/own-ais.json `loop_guards` { repeat_nudge_after, repeat_give_back_after, error_budget, words }
 * → { after({ name, args, failed, malformed }) → { nudge?: text, give_back?: text } | null }
 */
export function makeLoopGuard(rules) {
  let previous = null;
  let repeats = 0;
  let failures = 0;
  return {
    after({ name, args, failed = false, malformed = false }) {
      if (malformed) return null;
      const key = `${name}:${canonical(args)}`;
      repeats = key === previous ? repeats + 1 : 1;
      previous = key;
      failures = failed ? failures + 1 : 0;
      const values = { name, count: String(repeats), failures: String(failures) };
      const fill = line => line.replace(/\{(\w+)\}/g, (_, field) => values[field] ?? '');
      if (rules.error_budget > 0 && failures >= rules.error_budget) return { give_back: fill(rules.words.errors_spent) };
      if (rules.repeat_give_back_after > 0 && repeats >= rules.repeat_give_back_after) return { give_back: fill(rules.words.repeat_spent) };
      if (rules.repeat_nudge_after > 0 && repeats === rules.repeat_nudge_after) return { nudge: fill(rules.words.repeat_nudge) };
      return null;
    },
  };
}
