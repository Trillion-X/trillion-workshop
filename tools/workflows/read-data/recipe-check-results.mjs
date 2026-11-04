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

const same = value => JSON.stringify(value);

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
    const failing = evaluate(check, context, options);
    if (!Array.isArray(failing)) return { kind: check.kind, says: check.says, evaluated: false, reason: failing.reason };
    return { kind: check.kind, says: check.says, passed: failing.length === 0, failing };
  });
}
