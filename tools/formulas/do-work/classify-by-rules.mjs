// tools/formulas/do-work/classify-by-rules.mjs
//
// Purpose
//   Give one record the label of the FIRST rule whose clauses all hold. The facts a rule reads are projections of the record
//   (is it present, as a number, as an age in seconds, as it is); the rules, their labels, tones and severities are all in the
//   request. Nothing here names a field, a label or a threshold.
//
// Request
//   facts:  [{ key, path: [names or list positions], as: "present" | "number" | "age-seconds" | "value" }]
//   rules:  [{ key, label, tone?, severity?, requires: [{ fact, op: "present" | "absent" | "gte" | "lte" | "eq", value? }] }]
//   record: the object the facts are read from
//   now_ms: the clock for "age-seconds" facts, required when one is declared (the tool never reads the clock itself)
//
// Invariants
//   - First match in rule order wins; no rule holding gives { result: null }.
//   - "present" is true for a true flag, a number above zero, text with a non-space character, a non-empty list or object.
//     "number" is the number (or numeric text) at the path, 0 when there is none. "age-seconds" is the whole seconds from the
//     timestamp (milliseconds, or RFC 3339 text) to now_ms, never below 0, and 0 when there is no timestamp.
//   - gte and lte need a number on both sides (numeric text counts); anything else does not hold. eq compares numbers by
//     value (numeric text counts) and everything else exactly.
//   - A tone or severity is returned as given (trimmed), or null when the rule gives none: the words are the caller's.
//   - A request that is unfinished (a rule with no key, label or clauses, a clause naming a fact that was not declared, an
//     operator that is not listed) is refused with a sentence, never skipped or guessed.

const OPERATIONS = ['present', 'absent', 'gte', 'lte', 'eq'];
const PROJECTIONS = ['present', 'number', 'age-seconds', 'value'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };

function readAt(root, path) {
  let at = root;
  for (const step of path) {
    if (Array.isArray(at)) {
      if (!/^\d+$/.test(String(step))) return undefined;
      at = at[Number(step)];
    } else if (isObject(at) && typeof step === 'string' && Object.hasOwn(at, step)) at = at[step];
    else return undefined;
    if (at === undefined) return undefined;
  }
  return at;
}

function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') { const parsed = Number(value.trim()); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}

function millisecondsOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isNaN(parsed) ? null : parsed; }
  return null;
}

function project(record, fact, nowMs) {
  const raw = readAt(record, fact.path ?? []);
  if (fact.as === 'present') return present(raw);
  if (fact.as === 'number') return numberOf(raw) ?? 0;
  if (fact.as === 'age-seconds') {
    const started = millisecondsOf(raw);
    return started === null ? 0 : Math.round(Math.max(nowMs - started, 0) / 1000);
  }
  return raw ?? null;
}

function same(left, right) {
  const [a, b] = [numberOf(left), numberOf(right)];
  if (a !== null && b !== null) return a === b;
  return JSON.stringify(left) === JSON.stringify(right);
}

function holds(value, clause) {
  if (clause.op === 'present') return present(value);
  if (clause.op === 'absent') return !present(value);
  if (clause.op === 'eq') return clause.value !== undefined && same(value, clause.value);
  const [left, right] = [numberOf(value), numberOf(clause.value)];
  if (left === null || right === null) return false;
  return clause.op === 'gte' ? left >= right : left <= right;
}

export function classifyByRules(request) {
  need(isObject(request), 'Send an object with facts, rules and a record.');
  need(isObject(request.record), 'record must be the object the facts are read from.');
  need(Array.isArray(request.facts) && request.facts.every(fact => isObject(fact) && typeof fact.key === 'string' && fact.key !== '' && PROJECTIONS.includes(fact.as) && (fact.path === undefined || (Array.isArray(fact.path) && fact.path.every(step => typeof step === 'string' || (Number.isInteger(step) && step >= 0))))), `facts must be a list of { key, path, as } with as one of ${PROJECTIONS.join(', ')}.`);
  need(new Set(request.facts.map(fact => fact.key)).size === request.facts.length, 'two facts share a key; each fact key must be its own.');
  need(Array.isArray(request.rules), 'rules must be a list of { key, label, tone?, severity?, requires }.');
  need(request.rules.every(rule => isObject(rule) && typeof rule.key === 'string' && rule.key.trim() !== '' && typeof rule.label === 'string' && rule.label.trim() !== '' && Array.isArray(rule.requires) && rule.requires.length > 0), 'every rule needs a key, a label and at least one clause in requires.');
  const declared = new Set(request.facts.map(fact => fact.key));
  for (const rule of request.rules) {
    for (const clause of rule.requires) {
      need(isObject(clause) && OPERATIONS.includes(clause.op), `rule ${JSON.stringify(rule.key)} has a clause whose op is not one of ${OPERATIONS.join(', ')}.`);
      need(declared.has(clause.fact), `rule ${JSON.stringify(rule.key)} reads the fact ${JSON.stringify(clause.fact ?? null)}, which facts does not declare.`);
    }
  }
  need(request.now_ms === undefined || Number.isFinite(request.now_ms), 'now_ms must be a number of milliseconds.');
  need(request.now_ms !== undefined || !request.facts.some(fact => fact.as === 'age-seconds'), 'a fact read as age-seconds needs now_ms, the time to measure the age to.');
  const values = new Map(request.facts.map(fact => [fact.key, project(request.record, fact, request.now_ms)]));
  const rule = request.rules.find(candidate => candidate.requires.every(clause => holds(values.get(clause.fact), clause)));
  const words = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  return { result: rule ? { key: rule.key, label: rule.label, tone: words(rule.tone), severity: words(rule.severity) } : null };
}
