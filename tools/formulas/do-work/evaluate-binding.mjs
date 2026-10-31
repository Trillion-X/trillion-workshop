// tools/formulas/do-work/evaluate-binding.mjs
//
// Purpose
//   Evaluate a binding over a JSON value. A binding selects a value from the
//   row (select.from "self", read at select.path) or states one (from
//   "literal"), then runs a pipeline of operators over it. The operator set is
//   the one the comparison rows in read-data/rule-operators.json use: and, or,
//   not, eq, gt, ge, lt, le, in_list, index_of, is_null, is_empty, lower,
//   contains, starts_with, join.
//
// Non-negotiable invariants
//   - Three-state logic: and, or and not answer true, false or null (unknown).
//     NOT of unknown stays unknown. Only true matches a filter.
//   - A comparison with an unknown side (gt, ge, lt, le, contains, starts_with,
//     lower, join, index_of) is unknown, never false, so a row with an unknown
//     value matches neither such a comparison nor its negation.
//   - eq and in_list are different: an unknown value is a value that is not
//     equal to / not in the list, so they answer false and their negations
//     (is_none_of, is_not_text) keep the row. This is the semantics of the
//     engine operators these two were taken from.
//   - A value of the wrong type for an operator is an error. An error at the
//     top of a binding makes the whole evaluation an error (a filter counts the
//     row in error_rows and leaves it out); an error inside a nested binding
//     is an unknown value.
//   - Nothing is read outside the row: a path never reaches __proto__,
//     prototype or constructor, and a missing key is an unknown value.
//   - An operator that is not in the set above is an error naming it.

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class OpError extends Error {}

const typeOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
const mismatch = (operation, expected, value) => new OpError(`${operation}: expected ${expected}, got ${typeOf(value)}`);

const isNull = value => value === null || value === undefined;
const known = value => (value === undefined ? null : value);

function equal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, at) => equal(item, b[at]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return a === b;
}

function truthy(value) {
  if (isNull(value)) return false;
  if (typeof value === 'object') return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
  return Boolean(value);
}

const boolOrNull = (operation, value) => {
  if (isNull(value)) return null;
  if (typeof value === 'boolean') return value;
  throw mismatch(operation, 'boolean or null', value);
};
const stringOrNull = (operation, value) => {
  if (isNull(value)) return null;
  if (typeof value === 'string') return value;
  throw mismatch(operation, 'string or null', value);
};
const arrayOrNull = (operation, value) => {
  if (isNull(value)) return null;
  if (Array.isArray(value)) return value;
  throw mismatch(operation, 'array or null', value);
};

// Strings compare by their UTF-8 bytes, which is code point order.
const compareStrings = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function compare(operation, test) {
  return (input, args) => {
    const other = known(args.value);
    if (isNull(input) || other === null) return null;
    if (typeof input === 'number' && typeof other === 'number') return test(Math.sign(input - other));
    if (typeof input === 'string' && typeof other === 'string') return test(compareStrings(input, other));
    if (typeof input === 'boolean' && typeof other === 'boolean') return test(Number(input) - Number(other));
    throw new OpError(`${operation}: expected comparable types (number, string, boolean), got ${typeOf(input)} and ${typeOf(other)}`);
  };
}

function many(operation, decides, otherwise) {
  return (_input, args) => {
    const values = Array.isArray(args.values) ? args.values : [];
    if (!values.length) return !decides;
    let sawNull = false;
    for (const value of values) {
      const answer = boolOrNull(operation, value);
      if (answer === decides) return decides;
      if (answer === null) sawNull = true;
    }
    return sawNull ? null : otherwise;
  };
}

const text = value => {
  if (isNull(value)) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const OPERATORS = {
  'op:core.and': many('and', false, true),
  'op:core.or': many('or', true, false),
  'op:core.not': input => {
    const answer = boolOrNull('not', input);
    return answer === null ? null : !answer;
  },
  'op:core.is_null': input => isNull(input),
  'op:core.is_empty': input => !truthy(input),
  'op:core.eq': (input, args) => equal(known(input), known(args.value)),
  'op:core.gt': compare('gt', order => order > 0),
  'op:core.ge': compare('ge', order => order >= 0),
  'op:core.lt': compare('lt', order => order < 0),
  'op:core.le': compare('le', order => order <= 0),
  'op:core.in_list': (input, args) => {
    const list = arrayOrNull('includes', known(args.values));
    return list === null ? null : list.some(item => equal(item, known(input)));
  },
  'op:core.index_of': (input, args) => {
    const list = arrayOrNull('index_of', input);
    return list === null ? null : list.findIndex(item => equal(item, known(args.value)));
  },
  'op:core.lower': input => {
    const value = stringOrNull('lower', input);
    return value === null ? null : value.toLowerCase();
  },
  'op:core.contains': (input, args) => {
    const [haystack, needle] = [stringOrNull('contains', input), stringOrNull('contains', known(args.value))];
    return haystack === null || needle === null ? null : haystack.includes(needle);
  },
  'op:core.starts_with': (input, args) => {
    const [haystack, prefix] = [stringOrNull('starts_with', input), stringOrNull('starts_with', known(args.prefix))];
    return haystack === null || prefix === null ? null : haystack.startsWith(prefix);
  },
  'op:core.join': (input, args) => {
    const list = arrayOrNull('join', input);
    const delimiter = stringOrNull('join', known(args.delimiter));
    return list === null || delimiter === null ? null : list.map(text).join(delimiter);
  },
};

/** The operator ids this evaluator runs. */
export const operatorIds = Object.keys(OPERATORS);

function readAt(root, path) {
  if (path === undefined || path === null) return root;
  if (!Array.isArray(path)) throw new OpError('select.path must be a list of keys and positions');
  let at = root;
  for (const step of path) {
    if (typeof step === 'string') {
      if (FORBIDDEN_KEYS.has(step)) return null;
      if (at === null || typeof at !== 'object' || Array.isArray(at) || !Object.hasOwn(at, step)) return null;
      at = at[step];
    } else if (Number.isInteger(step) && step >= 0) {
      if (!Array.isArray(at) || step >= at.length) return null;
      at = at[step];
    } else {
      throw new OpError('select.path holds only text keys and whole-number positions');
    }
  }
  return known(at);
}

const isBinding = value => value !== null && typeof value === 'object' && !Array.isArray(value) && value.$kind === 'binding';

// Arguments may hold nested bindings; each is evaluated over the value the
// operator receives, and an error inside one is an unknown value.
function evaluateArgs(value, current) {
  if (Array.isArray(value)) return value.map(item => evaluateArgs(item, current));
  if (value === null || typeof value !== 'object') return value;
  if (isBinding(value)) return run(value, current).value ?? null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluateArgs(item, current)]));
}

function run(binding, input) {
  const fallback = () => (binding.default === undefined ? null : evaluateArgs(binding.default, input));
  try {
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding) || binding.$kind !== 'binding') {
      throw new OpError('a binding is an object with "$kind": "binding"');
    }
    const select = binding.select ?? {};
    if (select.from !== undefined && select.from !== 'self' && select.from !== 'literal') {
      throw new OpError(`select.from "${select.from}" is not read here; use "self" or "literal"`);
    }
    let value = select.from === 'literal' ? known(select.value ?? null) : readAt(input, select.path);
    if (binding.transform !== undefined && !Array.isArray(binding.transform)) throw new OpError('transform must be a list of steps');
    for (const [at, step] of (binding.transform ?? []).entries()) {
      const operator = Object.hasOwn(OPERATORS, step?.op) ? OPERATORS[step.op] : null;
      if (!operator) throw new OpError(`operator not supported: ${step?.op} (step ${at})`);
      const args = step.args === undefined || step.args === null ? {} : evaluateArgs(step.args, value);
      if (typeof args !== 'object' || Array.isArray(args)) throw new OpError(`${step.op}: args must be an object`);
      value = operator(value, args);
    }
    return { value: isNull(value) ? fallback() : value, error: null };
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    return { value: fallback(), error: error.message };
  }
}

/** Evaluate one binding over one value: { value, error }. */
export function evaluateBinding(binding, input) {
  return run(binding, input);
}

/**
 * The indices of the rows a binding holds for. A row matches only when the
 * binding yields true; an unknown value or any other value does not match; a
 * row that errors is counted in errorRows and left out. A null binding means
 * "no rule": every row matches.
 */
export function filterRows(rows, binding) {
  if (binding === null || binding === undefined) return { matches: rows.map((_row, at) => at), errorRows: 0, firstError: null };
  const outcome = { matches: [], errorRows: 0, firstError: null };
  rows.forEach((row, at) => {
    const { value, error } = run(binding, row);
    if (error !== null) {
      outcome.errorRows += 1;
      outcome.firstError ??= error;
    } else if (value === true) outcome.matches.push(at);
  });
  return outcome;
}
