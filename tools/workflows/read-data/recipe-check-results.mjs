// tools/workflows/read-data/recipe-check-results.mjs
//
// Runs a recipe step's checks against what the step handed back, so a check is not only valid (recipe-problems.mjs)
// but also judged. A step's checks read `this` (the step's own output), `input` (what the person gave the workflow) and
// `steps.<id>` (an earlier step's output), exactly the roots recipe-check-kinds.json names.
//
//   checkResults(step, { this: output, input, steps }, { catalogs }) -> [{ kind, says, passed, failing } | { kind, says, evaluated: false, reason }]
//
// A path is a list of keys after its root; `*` walks every item of a list. The values at a path are what it ends on,
// and a list it ends on gives its items. Values are compared as exact JSON. `exists` asks `catalogs[<catalog>]`, a
// function (id) -> boolean the caller supplies; without one the check is reported as not evaluated, never as passed.
// A kind with no evaluator here is reported the same way, so a kind added only as a vocabulary row is never taken as
// having run.

import { laneIds, laneJobId } from './step-agents.mjs';

const same = value => JSON.stringify(value);
// Something is there: not missing, null, blank text, or an empty list or object.
const filled = value => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())
  && !(Array.isArray(value) && !value.length) && !(typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);

// The values a path ends on, from the roots in `context`.
export function valuesAt(path, context) {
  const [root, ...keys] = path;
  let at = [root === 'this' ? context.this : context[root]];
  for (const key of keys) {
    at = key === '*'
      ? at.flatMap(value => (Array.isArray(value) ? value : []))
      : at.map(value => (value != null && typeof value === 'object' ? value[key] : undefined));
  }
  return at.flatMap(value => (Array.isArray(value) ? value : [value])).filter(value => value !== undefined);
}

const textAt = (path, context) => valuesAt(path, context).map(value => (typeof value === 'string' ? value : same(value))).join('\n');
const missingFrom = (values, from) => { const have = new Set(from.map(same)); return values.filter(value => !have.has(same(value))); };

// One evaluator per row of recipe-check-kinds.json: (check, context, options) -> the values that fail it.
export const CHECK_EVALUATORS = {
  'subset-of': (check, c) => missingFrom(valuesAt(check.path, c), valuesAt(check.of, c)),
  covers: (check, c) => missingFrom(check.values ?? valuesAt(check.of, c), valuesAt(check.path, c)),
  'mentioned-in': (check, c) => { const text = textAt(check.in, c).toLowerCase(); return valuesAt(check.path, c).filter(value => !text.includes(String(value).toLowerCase())); },
  'excludes-words': (check, c) => { const text = textAt(check.path, c).toLowerCase(); return check.words.filter(word => text.includes(word.toLowerCase())); },
  'distinct-at-least': (check, c) => { const values = valuesAt(check.path, c); return new Set(values.map(same)).size >= check.count ? [] : values; },
  'differs-from': (check, c) => { const of = new Set(valuesAt(check.of, c).map(same)); return valuesAt(check.path, c).filter(value => of.has(same(value))); },
  // One lane per agent of the step, each handed back with the id of its own job, and each such job one that ran: the
  // lane ids are the step's own (laneIds), a job's id is fixed by the run, step and lane (laneJobId) so no job stands
  // for two lanes, and `ran-job` is the catalog the caller looks a finished job up in, answering the taker that finished it (nothing when it did not run); a taker that finished two lanes fails both. The failing values are lane ids.
  'lane-jobs': (check, c, { catalogs = {}, step } = {}) => {
    if (!step) return { reason: 'the check needs the step it belongs to, to know its lanes' };
    const failing = new Set();
    const lanes = new Map(), jobs = new Set();
    for (const item of valuesAt(check.path, c)) {
      const lane = item?.[check.lane], job = item?.[check.job];
      if (lanes.has(lane)) failing.add(lane); else lanes.set(lane, job);
      if (jobs.has(job)) failing.add(lane); else jobs.add(job);
    }
    for (const lane of laneIds(step)) {
      const job = lanes.get(lane);
      const own = c.run === undefined ? typeof job === 'string' && job.endsWith(`:${step.id}:${lane}`) : job === laneJobId(c.run, step.id, lane);
      if (!lanes.has(lane) || !own) failing.add(lane);
    }
    for (const lane of lanes.keys()) if (!laneIds(step).includes(lane)) failing.add(lane);
    if (failing.size) return [...failing];
    const ran = catalogs['ran-job'];
    if (typeof ran !== 'function') return { reason: 'no ran-job catalog was given to look the lanes\' jobs up in' };
    // The catalog answers the taker that finished the job, and nothing when it did not run; two lanes done by one taker fail.
    const takers = new Map([...lanes].map(([lane, job]) => [lane, ran(job)]));
    const count = new Map();
    for (const taker of takers.values()) if (taker) count.set(taker, (count.get(taker) ?? 0) + 1);
    return [...takers].filter(([, taker]) => !taker || count.get(taker) > 1).map(([lane]) => lane);
  },
  // Items at a path that lack a field: each answer item is named by its own id (else its place in the list) and the field.
  'fields-present': (check, c) => valuesAt(check.path, c).flatMap((item, at) => check.fields
    .filter(field => !filled(item?.[field])).map(field => `${item?.id ?? at}.${field}`)),
  'field-in': (check, c) => valuesAt(check.path, c).flatMap((item, at) => (check.values.map(same).includes(same(item?.[check.field])) ? [] : [`${item?.id ?? at}.${check.field}`])),
  // What each item cites, resolved beforehand by citation-resolvers.mjs (a lookup is async; a check is judged at once):
  // `resolved(check, item)` answers [{ cite, ok, why }]. An unresolved item or a citation that cannot be looked up here
  // (ok: null) leaves the check unevaluated, never passed.
  'cites-resolve': (check, c, { resolved } = {}) => {
    if (typeof resolved !== 'function') return { reason: 'the citations were not looked up' };
    const failing = [];
    for (const [at, item] of valuesAt(check.path, c).entries()) {
      const found = resolved(check, item);
      if (!found) return { reason: 'the citations were not looked up' };
      const blind = found.find(one => one.ok === null);
      if (blind) return { reason: `${blind.cite}: ${blind.why}` };
      const id = item?.id ?? at;
      if (found.length < (check.at_least ?? 0)) failing.push(`${id}.${check.field}: cites ${found.length}, needs ${check.at_least}`);
      for (const one of found) if (!one.ok) failing.push(`${id}.${check.field}: ${one.cite} (${one.why})`);
    }
    return failing;
  },
  exists: (check, c, { catalogs = {} } = {}) => {
    const known = catalogs[check.catalog];
    if (typeof known !== 'function') return { reason: `no ${check.catalog} catalog was given to look ids up in` };
    return valuesAt(check.path, c).filter(id => !known(id));
  },
};

export function checkResults(step, context, options = {}) {
  return (step.checks ?? []).map(check => {
    const evaluate = CHECK_EVALUATORS[check.kind];
    if (!evaluate) return { kind: check.kind, says: check.says, evaluated: false, reason: `no evaluator for kind ${check.kind}` };
    const failing = evaluate(check, context, { ...options, step });
    if (!Array.isArray(failing)) return { kind: check.kind, says: check.says, evaluated: false, reason: failing.reason };
    return { kind: check.kind, says: check.says, passed: failing.length === 0, failing };
  });
}
