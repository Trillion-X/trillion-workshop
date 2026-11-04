// parts/formula-engine/rules/evaluation-guards.mjs
//
// Purpose
//   The limits a formula is held to at the one door every evaluation passes
//   (evaluate-over-rows.mjs): how deep and how large a binding may be, whether
//   it contains itself, whether a pattern it compiles is safe, how much work
//   one call may do, and how long it may run. A bad formula is refused in its
//   own words instead of freezing the page or the store that asked.
//
// Non-negotiable invariants
//   - Every limit and every refusal's words are DATA (evaluation-guards.json);
//     nothing here names a field, a list or a caller.
//   - A binding is checked before the evaluator sees it: the walk is
//     iterative (a deep binding cannot overflow the checker's own stack) and
//     stops at the first limit passed.
//   - The work budget (rows times the binding's weight) is known before the
//     call starts, so it holds on every host, including a Cloudflare Worker,
//     whose clock does not move while code runs. The clock budget is checked
//     between row slices where the clock does move (a page, Node).
//   - A refusal is an Error with `code: 'formula_guard'`, `guard` (which
//     limit) and `limit`; it never answers a partial result.
//
// What lives where
//   The evaluator itself (../trillion-rust/crates/evaluate-over-rows, compiled to wasm) refuses
//   input nested too deeply (FE_PAYLOAD_TOO_DEEP) and compiles patterns with
//   Rust regex, which runs in linear time. Stopping a single evaluation part way
//   through needs fuel metering inside the wasm, which only a rebuild of that
//   crate can add; these guards decide everything that can be decided before and
//   between evaluator calls.

import guards from './evaluation-guards.json' with {type: 'json'};

const regexOps = new Map(guards.regex_ops.map(row => [row.op, row.pattern]));
const slow = new Map();
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const words = (guard, values) => guards.words[guard].replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/** The refusal of one guard, in its own words. */
export function guardRefusal(guard, values = {}) {
  return Object.assign(new Error(words(guard, values)), {code: 'formula_guard', guard, limit: values.limit ?? null});
}

// The largest count a pattern repeats anything ({n}, {n,} or {n,m}), or 0.
const largestRepeat = pattern => Math.max(0, ...[...pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)].map(match => Math.max(Number(match[1]), Number(match[2] || 0))));

/**
 * Checks one binding before it is evaluated: { weight } (its parts, a regex op weighing regex_weight), or a
 * guard refusal. A binding seen before is answered from the last check.
 */
const checked = new WeakMap();
export function checkBinding(binding) {
  if (!binding || typeof binding !== 'object') return {weight: 1};
  const known = checked.get(binding);
  if (known) return known;
  let nodes = 0;
  let regexes = 0;
  // Each pending entry is a value and the objects above it (its ancestry), so a value inside itself is a cycle.
  const pending = [{value: binding, depth: 1, above: new Set()}];
  while (pending.length) {
    const {value, depth, above} = pending.pop();
    nodes += 1;
    if (nodes > guards.max_nodes) throw guardRefusal('too_large', {limit: guards.max_nodes});
    if (!value || typeof value !== 'object') continue;
    if (depth > guards.max_depth) throw guardRefusal('too_deep', {limit: guards.max_depth});
    if (above.has(value)) throw guardRefusal('cycle', {});
    const patternKey = !Array.isArray(value) && typeof value.op === 'string' ? regexOps.get(value.op) : undefined;
    if (patternKey !== undefined) {
      regexes += 1;
      if (regexes > guards.regex_per_binding) throw guardRefusal('unsafe_regex', {why: `more than ${guards.regex_per_binding} patterns`});
      const pattern = value.args?.[patternKey];
      if (typeof pattern === 'string') {
        if (pattern.length > guards.regex_chars) throw guardRefusal('unsafe_regex', {why: `longer than ${guards.regex_chars} characters`});
        if (largestRepeat(pattern) > guards.regex_repeat_most) throw guardRefusal('unsafe_regex', {why: `repeats something more than ${guards.regex_repeat_most} times`});
      }
    }
    const next = new Set(above).add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) pending.push({value: child, depth: depth + 1, above: next});
  }
  const answer = {weight: nodes + regexes * guards.regex_weight};
  checked.set(binding, answer);
  return answer;
}

/** Refuses a call whose work (rows times the binding's weight) is past max_work. */
export function checkWork(weight, rows) {
  const work = weight * Math.max(1, rows);
  if (work > guards.max_work) throw guardRefusal('too_much_work', {work, limit: guards.max_work});
}

// A formula that ran past budget_ms is refused until slow_ms has passed; at most slow_kept are remembered.
const slowKey = binding => JSON.stringify(binding);
export function refuseIfSlow(binding) {
  const key = slowKey(binding);
  const until = slow.get(key);
  if (until === undefined) return;
  if (clock() < until) throw guardRefusal('over_time', {limit: guards.budget_ms});
  slow.delete(key);
}
export function noteTime(binding, started) {
  if (clock() - started <= guards.budget_ms) return;
  slow.set(slowKey(binding), clock() + guards.slow_ms);
  while (slow.size > guards.slow_kept) slow.delete(slow.keys().next().value);
}

/**
 * Filters `rows` with `run(slice) → {matches, errorRows, firstError}` a slice at a time, stopping between slices
 * once the call is past budget_ms (refused: over_time, the formula marked slow).
 */
export function inSlices(binding, rows, run) {
  const started = clock();
  const out = {matches: [], errorRows: 0, firstError: null};
  for (let from = 0; from < rows.length || from === 0; from += guards.rows_per_slice) {
    if (from > 0 && clock() - started > guards.budget_ms) {
      noteTime(binding, started);
      throw guardRefusal('over_time', {limit: guards.budget_ms});
    }
    const reply = run(rows.slice(from, from + guards.rows_per_slice));
    for (const index of reply.matches) out.matches.push(from + index);
    out.errorRows += reply.errorRows ?? 0;
    out.firstError ??= reply.firstError ?? null;
    if (rows.length === 0) break;
  }
  noteTime(binding, started);
  return out;
}
