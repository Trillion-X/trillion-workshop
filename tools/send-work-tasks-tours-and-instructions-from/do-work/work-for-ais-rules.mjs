// tools/send-work-tasks-tours-and-instructions-from/do-work/work-for-ais-rules.mjs
//
// The rules of work sent to customers' AIs: which rows of work a row is, which are in force, when they hold (trigger,
// window, audience) and the handoff each one becomes for the account whose AI takes it. Ported from the old owner's
// src/work-for-ais.mjs at commit b6ae0ebf81 (the tag named in moved-from.json): checkedRow (lines 36-59), rowsInForce
// (61-66), inWindow (68-73), triggersFor (124-128), handoffFor (130-134) and rowsFor (136-147).
//
// The rules are DATA: every function takes the `rules` object (the work-for-ais settings: triggers, limits, words,
// handoff, default_trigger, default_priority, new_account_hours) from its owner, and never reads a file itself. An
// audience is a formula-engine rule group; the caller passes `matches(tree, fields, facts)` that answers whether the
// group holds, so this file does not interpret rules.
//
// Not here yet (tool rows of this folder, see README): the delivery on connect, the operator's row store and tools,
// and the account facts (tools/decide-when-things-show/read-data/account-facts.mjs holds those).

export class WorkForAisError extends Error {}

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The row as kept, or an error in plain words. Nothing outside the row's own fields is kept. */
export function checkedRow(row, rules) {
  const { words, limits, triggers } = rules;
  // A row over a cap says which cap and how long it is, not only that the row is wrong.
  if (object(row)) {
    for (const [value, key] of [[row.id, 'id_chars'], [row.job, 'job_chars'], [row.said, 'said_chars']]) {
      if (typeof value === 'string' && value.length > limits[key]) throw new WorkForAisError(`${key.replace('_chars', '')} is ${value.length} characters; the most is ${limits[key]}.`);
    }
  }
  if (!object(row) || typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(row.id) || row.id.length > limits.id_chars
    || typeof row.job !== 'string' || !row.job.trim() || row.job.length > limits.job_chars
    || (row.said != null && (typeof row.said !== 'string' || row.said.length > limits.said_chars))) throw new WorkForAisError(words.bad_row);
  const trigger = row.trigger ?? rules.default_trigger;
  if (!Object.hasOwn(triggers, trigger)) throw new WorkForAisError(fill(words.bad_trigger, { triggers: Object.keys(triggers).join(', ') }));
  const priority = row.priority ?? rules.default_priority;
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) throw new WorkForAisError(words.bad_priority);
  const window = row.window ?? {};
  if (!object(window) || (window.from != null && !iso(window.from)) || (window.until != null && !iso(window.until))
    || (window.from != null && window.until != null && Date.parse(window.from) >= Date.parse(window.until))) throw new WorkForAisError(words.bad_window);
  if (row.audience != null && (!object(row.audience) || row.audience.kind !== 'group')) throw new WorkForAisError(words.bad_audience);
  return { id: row.id, ...(row.said ? { said: row.said } : {}), job: row.job.trim(), ...(row.audience ? { audience: row.audience } : {}),
    ...(window.from || window.until ? { window: { ...(window.from ? { from: window.from } : {}), ...(window.until ? { until: window.until } : {}) } } : {}),
    trigger, priority };
}

/** The rows in force: shipped rows, replaced by a kept row with the same id, less any row ended. */
export function rowsInForce(shipped, kept) {
  const byId = new Map(shipped.map(row => [row.id, row]));
  for (const row of kept) byId.set(row.id, row);
  return [...byId.values()].filter(row => !row.ended_at);
}

/** Whether `nowMs` is inside the row's window (a missing end of the window is open). */
export function inWindow(row, nowMs) {
  const from = row.window?.from ? Date.parse(row.window.from) : -Infinity;
  const until = row.window?.until ? Date.parse(row.window.until) : Infinity;
  return nowMs >= from && nowMs < until;
}

/** The events that hold for this account right now, from its facts. */
export function triggersFor(facts, nowMs, rules) {
  const fresh = Number.isFinite(facts.created_at) && nowMs - facts.created_at <= rules.new_account_hours * 3600000;
  return ['connect', ...(fresh ? ['account-created'] : []), ...(facts.setup_done ? [] : ['setup-unfinished'])];
}

/** The handoff for one row, once per row for the account whose AI it is handed to. */
export function handoffFor(row, rules) {
  return { job: row.job, ...(row.said ? { said: row.said } : {}), priority: row.priority ?? rules.default_priority,
    once_per: `${rules.handoff.once_per_prefix}${row.id}`, input: { [rules.handoff.input_key]: { row: row.id, trigger: row.trigger ?? rules.default_trigger } } };
}

/** The rows that hold for one account's facts at one time, highest priority first. `matches(tree, fields, facts)` is the
 *  formula-engine row filter over one audience; a row with no audience reaches everyone. */
export async function rowsFor({ rows, facts, nowMs, matches, rules }) {
  const triggers = new Set(triggersFor(facts, nowMs, rules));
  const held = [];
  for (const row of rows) {
    if (!triggers.has(row.trigger ?? rules.default_trigger) || !inWindow(row, nowMs)) continue;
    if (row.audience && !(await matches(row.audience, rules.facts, facts))) continue;
    held.push(row);
  }
  return held.sort((a, b) => (b.priority ?? rules.default_priority) - (a.priority ?? rules.default_priority) || (a.id < b.id ? -1 : 1));
}
