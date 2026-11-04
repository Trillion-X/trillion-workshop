// src/capability-checks.mjs
//
// Purpose
//   Everything that ever worked in Trillion is checked by itself, all the time, from what really arrives to what really
//   comes out, so nothing stops silently. Each check is one of the person's own records (`record:capability-check:<id>`,
//   the rows of the list src/capability-checks.json `list`): a probe (one of Trillion's own tools, asked inside the
//   person's store exactly as their AI asks it), the facts read from its answer, when the check applies and what a
//   working answer looks like, both as formula-engine rule trees. Each wake (the scheduler source `capability-checks`)
//   runs the checks that are due, keeps on each row its state, when it last worked, when it was checked and what was
//   seen, and a check failing `failures_before_handing_off` times in a row is a stop src/keep-running.mjs hands to one
//   AI with that evidence and tells the person about, once per stop. On 2026-10-05 a person asked whether their messages,
//   recordings, listening and cameras were all still arriving: nothing watched them, and several had stopped for hours.
//
// Non-negotiable invariants
//   1. Nothing here names a tool, a fact, an app or a capability: checks are the person's records and starter rows of
//      src/capability-checks.json; reads and states are DATA; comparisons are the formula engine's (filterRows).
//   2. A probe is asked through the same tools an AI uses (tools: makeTools over the store's own routes), so a check
//      that passes means the road an AI takes works, never a private shortcut. Probes only read: a check never changes
//      what it checks.
//   3. A check that cannot be read (the probe threw or answered an error, or the answer lacks a fact `expect` names) is failing with
//      what was seen, never quietly skipped: a check whose own road broke is itself something that stopped.
//   4. A check whose `in_use` rule does not hold is "Not in use" (a source the person never uses is not broken), so the
//      same starters serve every account.
//   5. One failure is checked again after `recheck_after_minutes`; only `failures_before_handing_off` failures in a row
//      make it a stop (failing_since is when the first of them was seen), so one busy moment is never handed to an AI.
//   6. Identical probes in one wake are asked once (several checks read one answer).
//   7. Starters are added only where the person has no check of that id: a check the person or their AI changed is
//      never overwritten.
//   8. A probe whose answer is still being worked out (its `pending_when` rule holds: a long tool run still going) is
//      neither working nor failing: it is read again after `recheck_after_minutes`, and nothing is counted. A probe's
//      input may name the day, hour or minute it runs ({checked_on}, {checked_hour}, {checked_at}), so one long run a day is asked again by the
//      same key until it answers, never started twice.
//
// Key concepts
//   check   { check, label, owner, every_hours, shipped_in, probe: { tool, input }, facts: [{ id, kind, path, read }],
//           in_use: rule tree | null, pending_when: rule tree | null, expect: rule tree } plus what each run keeps: state (a label of `states`),
//           state_id, last_checked, last_worked, failing_since, failures, problem, read (the facts as last read)
//   path    keys, indices or { match: { path, equals } } (the first list item whose value at path equals)
//
import settings from './capability-checks.json' with { type: 'json' };

export const CAPABILITY_CHECKS = settings;
const HOUR = 3600000;
const MINUTE = 60000;
const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined || values[name] === null ? whole : String(values[name])));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Alarm timing needs no probe, rule tree or saved reading. Use the record owner's
// bounded grouped projection so cold checks do not open their unrelated graphs.
export function capabilityCheckTimes(records, type) {
  // reads-ok: five timing fields per check of one account, read once by nextAt until a check changes; it replaced reading every check whole.
  return [...records.fields.fieldsOf(type, records.ids(type),
    ['last_checked', 'pending', 'state_id', 'failures', 'every_hours'],
    { groupRoots: true, includeId: false, logicalFields: true }).values()];
}

/** The value at a path of an answer, or undefined. Pure. */
export function at(value, path) {
  let here = value;
  for (const step of path) {
    if (here === undefined || here === null) return undefined;
    if (isObject(step) && isObject(step.match)) {
      if (!Array.isArray(here)) return undefined;
      here = here.find(item => at(item, step.match.path ?? []) === step.match.equals);
    } else here = here[step];
  }
  return here;
}

// How each `read` turns the value at a path into a fact (src/capability-checks.json reads).
const READS = {
  value: value => value,
  count: value => (Array.isArray(value) ? value.length : undefined),
  hours_since: (value, now) => { const ms = Date.parse(value ?? ''); return Number.isFinite(ms) ? Math.max(0, (now - ms) / HOUR) : undefined; },
};

/** The facts a check reads from an answer: { facts: { id: value }, missing: [id] }. Pure. */
export function readFacts(answer, facts, now) {
  const out = {};
  const missing = [];
  for (const fact of facts) {
    const value = READS[fact.read]?.(at(answer, fact.path), now);
    if (value === undefined || value === null) { missing.push(fact.id); out[fact.id] = null; } else out[fact.id] = typeof value === 'number' ? Math.round(value * 100) / 100 : value;
  }
  return { facts: out, missing };
}

/** A check as given (a starter, or `add`), or the reason it is not one. Pure. */
export function checkOf(given, rules = settings) {
  const why = reason => { throw new Error(fill(rules.words.bad_check, { why: reason })); };
  if (!isObject(given)) why('it is not an object');
  if (!CHECK_ID.test(given.check ?? '')) why(`check ${JSON.stringify(given.check)} is not a name`);
  if (typeof given.label !== 'string' || !given.label.trim()) why('label is missing');
  if (!isObject(given.probe) || typeof given.probe.tool !== 'string') why('probe.tool is missing');
  if (!Array.isArray(given.facts) || !given.facts.length || given.facts.some(fact => !isObject(fact) || typeof fact.id !== 'string' || typeof fact.kind !== 'string' || !Array.isArray(fact.path) || !READS[fact.read])) why(`each fact needs id, kind, path and read (${Object.keys(rules.reads).join(', ')})`);
  if (!isObject(given.expect) || given.expect.kind !== 'group') why('expect is not a rule group');
  for (const name of ['in_use', 'pending_when']) if (given[name] !== undefined && given[name] !== null && (!isObject(given[name]) || given[name].kind !== 'group')) why(`${name} is not a rule group`);
  // A rule naming a fact the check does not read would hold for every answer (an unfinished rule keeps every row).
  const declared = new Set(given.facts.map(fact => fact.id));
  for (const name of ['expect', 'in_use', 'pending_when']) for (const field of fieldsOf(given[name])) if (!declared.has(field)) why(`${name} names ${field}, which is not one of its facts`);
  return {
    check: given.check, label: given.label.trim(), owner: typeof given.owner === 'string' ? given.owner : '',
    every_hours: Number.isFinite(given.every_hours) && given.every_hours > 0 ? given.every_hours : 1,
    shipped_in: typeof given.shipped_in === 'string' ? given.shipped_in : '',
    probe: { tool: given.probe.tool, input: isObject(given.probe.input) ? given.probe.input : {} },
    facts: given.facts.map(({ id, kind, path, read }) => ({ id, kind, path, read })),
    in_use: given.in_use ?? null, pending_when: given.pending_when ?? null, expect: given.expect,
  };
}

/** When a check is next due: never checked is due now; a failing one is checked again sooner. Pure. */
export function dueAt(check, rules = settings) {
  const last = Date.parse(check.last_checked ?? '');
  if (!Number.isFinite(last)) return 0;
  const soon = check.pending || (check.good_streak ?? 0) > 0 || (check.state_id === 'failing' && (check.failures ?? 0) < rules.failures_before_handing_off);
  const wait = soon ? rules.recheck_after_minutes * MINUTE : check.every_hours * HOUR;
  return last + wait;
}

/** Every fact a rule tree names. Pure. */
export const fieldsOf = (tree, found = new Set()) => {
  for (const node of tree?.rules ?? []) if (node.kind === 'group') fieldsOf(node, found); else if (typeof node.field === 'string') found.add(node.field);
  return found;
};

/** A probe's input with the day, hour and minute it runs filled into its words ({checked_on}, {checked_hour}, {checked_at}). Pure. */
export function inputAt(input, atMs) {
  const iso = new Date(atMs).toISOString();
  const values = { checked_on: iso.slice(0, 10), checked_hour: iso.slice(0, 13), checked_at: iso.slice(0, 16) };
  const walk = value => (typeof value === 'string' ? fill(value, values) : Array.isArray(value) ? value.map(walk) : isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)])) : value);
  return walk(input ?? {});
}

/**
 * rows        { all() → [{ id, values }], when?() → timing fields, keep([{ id, values }]) (merged into each record), ensureList() }
 * tools       () → [{ name, run(input) }], or a promise of them (src/tools.mjs makeTools over the store's own routes)
 * filterRows  the formula engine's row filter ({ tree, fields, rows } → { matches })
 */
export function makeCapabilityChecks({ rows, tools, filterRows, now = () => Date.now(), rules = settings }) {
  let next;
  const byName = async () => new Map((await tools()).map(tool => [tool.name, tool]));
  const holds = async (tree, facts, values) => (await filterRows({ tree, fields: facts.map(({ id, kind }) => ({ id, kind })), rows: [values] })).matches.length === 1;
  const stateLabel = id => rules.states[id].label;

  async function judge(check, answer, error, atMs) {
    if (error) return { state_id: 'failing', problem: fill(rules.words.no_answer, { tool: check.probe.tool, error }), read: null };
    const { facts, missing } = readFacts(answer, check.facts, atMs);
    if (check.pending_when && (await holds(check.pending_when, check.facts, facts))) return { pending: true, read: facts };
    if (check.in_use && !(await holds(check.in_use, check.facts, facts))) return { state_id: 'not_in_use', problem: '', read: facts };
    // Only a fact working is judged by must be there; the rest are evidence carried with what was seen.
    const needed = fieldsOf(check.expect);
    const lacking = missing.filter(id => needed.has(id));
    if (lacking.length) return { state_id: 'failing', problem: fill(rules.words.missing, { tool: check.probe.tool, facts: lacking.join(', ') }), read: facts };
    if (await holds(check.expect, check.facts, facts)) return { state_id: 'working', problem: '', read: facts };
    return { state_id: 'failing', problem: fill(rules.words.not_expected, { tool: check.probe.tool, read: JSON.stringify(facts) }), read: facts };
  }

  /** Every check with what it keeps, in check order. */
  const all = () => rows.all().map(({ id, values }) => ({ ...values, check: values.check ?? id })).sort((a, b) => a.check.localeCompare(b.check));
  /** Which of the requested checks exist, from identity metadata alone. Unrelated saved checks are never read. */
  const ids = candidates => rows.ids([...new Set(candidates)]);

  /** Adds the starters the person has no check for, and any checks given (`add`, replacing a check of the same id). */
  function keepChecks({ add = [], add_starters = false } = {}) {
    rows.ensureList();
    const have = new Set(ids(add_starters ? rules.starters.map(starter => starter.check) : []));
    const given = [...(add_starters ? rules.starters.filter(starter => !have.has(starter.check)) : []), ...add].map(item => checkOf(item, rules));
    if (given.length) rows.keep(given.map(check => ({ id: check.check, values: { ...check, state: stateLabel('not_checked'), state_id: 'not_checked' } })));
    next = undefined;
    return given.map(check => check.check);
  }

  /** Runs the checks due now (every one with every: true, or the one named), keeps each result, and says what changed. */
  async function runDue({ check_id = null, every = false } = {}) {
    const atMs = now();
    const checks = all();
    if (check_id && !checks.some(check => check.check === check_id)) throw new Error(fill(rules.words.unknown_check, { check_id, ids: checks.map(check => check.check).join(', ') }));
    const due = check_id ? checks.filter(check => check.check === check_id) : every ? checks : checks.filter(check => dueAt(check, rules) <= atMs).slice(0, rules.most_per_wake);
    const named = await byName();
    const asked = new Map();
    const ask = given => {
      const probe = { tool: given.tool, input: inputAt(given.input, atMs) };
      const key = JSON.stringify([probe.tool, probe.input]);
      if (!asked.has(key)) {
        const tool = named.get(probe.tool);
        asked.set(key, (async () => {
          if (!tool) return { error: `no tool ${probe.tool}` };
          try {
            const answer = await tool.run(probe.input ?? {});
            return isObject(answer) && typeof answer.error === 'string' ? { error: answer.error } : { answer };
          } catch (error) { return { error: String(error?.message ?? error) }; }
        })());
      }
      return asked.get(key);
    };
    const kept = [];
    const newlyStopped = [];
    for (const check of due) {
      const { answer, error } = await ask(check.probe);
      const result = await judge(check, answer, error, atMs);
      const iso = new Date(atMs).toISOString();
      if (result.pending) { kept.push({ id: check.check, values: { last_checked: iso, pending: true, read: result.read } }); continue; }
      // A stop returns to working only after `good_before_working` working answers in a row, so a flapping dependency is not announced as back.
      const wasStopped = check.state_id === 'failing' && (check.failures ?? 0) >= rules.failures_before_handing_off;
      const streak = result.state_id === 'working' && wasStopped ? (check.good_streak ?? 0) + 1 : 0;
      if (wasStopped && result.state_id === 'working' && streak < rules.good_before_working) {
        kept.push({ id: check.check, values: { last_checked: iso, pending: false, good_streak: streak, problem: fill(rules.words.recovering, { good: streak, needed: rules.good_before_working }), read: result.read } });
        continue;
      }
      const failing = result.state_id === 'failing';
      const failures = failing ? (check.state_id === 'failing' ? (check.failures ?? 0) + 1 : 1) : 0;
      const values = {
        state: stateLabel(result.state_id), state_id: result.state_id, last_checked: iso, pending: false,
        problem: String(result.problem).slice(0, rules.problem_chars), read: result.read, failures, good_streak: 0,
        failing_since: failing ? (check.state_id === 'failing' && check.failing_since ? check.failing_since : iso) : null,
        ...(result.state_id === 'working' ? { last_worked: iso } : {}),
      };
      if (failing && failures === rules.failures_before_handing_off) newlyStopped.push(check.check);
      kept.push({ id: check.check, values });
    }
    if (kept.length) rows.keep(kept);
    next = undefined;
    return { checked: kept.map(({ id, values }) => ({ check: id, state: values.pending ? rules.words.pending : values.state, problem: values.problem ?? '' })), newly_stopped: newlyStopped };
  }

  /** The checks that failed `failures_before_handing_off` times in a row, for src/keep-running.mjs. */
  const stopped = () => all().filter(check => check.state_id === 'failing' && (check.failures ?? 0) >= rules.failures_before_handing_off)
    .map(check => ({ check: check.check, label: check.label, owner: check.owner, failing_since: check.failing_since, failures: check.failures, problem: check.problem, probe: check.probe, expect: check.expect, read: check.read, last_worked: check.last_worked ?? null }));

  /** Every check as the screen and the tool show it, with what it says overall. */
  function status() {
    const checks = all();
    const failing = checks.filter(check => check.state_id === 'failing');
    const working = checks.filter(check => check.state_id === 'working');
    return {
      said: failing.length ? fill(rules.words.said_failing, { failing: failing.length, total: checks.length, labels: failing.map(check => check.label).join('; ') }) : fill(rules.words.said_all, { working: working.length, total: checks.length }),
      list_id: rules.list.id,
      checks: checks.map(check => ({ check: check.check, label: check.label, state: check.state, last_worked: check.last_worked ?? null, last_checked: check.last_checked ?? null, problem: check.problem ?? '', owner: check.owner })),
    };
  }

  /** When the next check is due, or null for an account with no checks; read once until something changes. */
  const nextAt = () => {
    if (next !== undefined) return next;
    const checks = rows.when ? rows.when() : all();
    let soonest = null;
    for (const check of checks) {
      const due = dueAt(check, rules);
      soonest = soonest === null ? due : Math.min(soonest, due);
    }
    next = soonest;
    return next;
  };
  const invalidate = () => { next = undefined; };

  return { ids, keepChecks, runDue, stopped, status, nextAt, invalidate };
}
