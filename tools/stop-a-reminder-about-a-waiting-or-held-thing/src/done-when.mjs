// src/done-when.mjs
//
// Purpose
//   Makes "done when" something Trillion checks instead of free text it shows. A row of the person's Waiting on you list
//   may carry a `done_when_rule` (src/lists.json kind done-when-rule): { over, match, tree, says }. `over` is a facts
//   source (src/done-when-facts.json: saved logins, connections, device facts, files, work, or another of the person's
//   lists), `tree` a formula engine rule group over that source's rows, `match` how many rows must pass it (all, any,
//   none) and `says` the plain words of what is counted. This file reads each source fresh, projects it into typed rows,
//   decides the tree with the formula engine's row filter, and answers what the row's card shows: card.check
//   { state: done | not_yet | cannot_check | failed, words, checked_at }.
//
// Non-negotiable invariants
//   1. Nothing here names a source, a field, an operator or a word shown: they are the DATA (src/done-when-facts.json
//      and parts/formula-engine/rules/rule-operators.json). A new source is one row there and one reader in the owner.
//   2. Every source is a real current read, asked each time a row is checked and shared only inside one pass over the
//      rows (`memo`), never kept here between passes. (The owner, src/person-store.mjs checkWaiting, may reuse a pass's
//      answers for a read made while the store's revision and change count are the same; a changed store asks again.)
//   3. A check is bounded: it answers within `check_seconds` however slow a source is. A source that was too slow is not
//      asked again by a reading screen for `retry_seconds` (it answers `failed` at once, saying when it tries again);
//      the check made because a source changed (`fresh`) always asks.
//   4. A check that cannot be made says so in plain words with a state of its own (cannot_check: no rule, an unknown
//      source or an unfinished rule; failed: a read threw or timed out), never a "Checking..." that does not end.
//   5. A rule is refused when it is written (`refusal`), in plain words naming what is allowed, so the rows that are
//      kept are rules the engine can finish. A rule it cannot finish later passes nothing and says it cannot check.
//   6. A check loads a bounded number of records (the DATA's rows_most): more fails, naming how many. A source with
//      `columns` reads only the columns the rule names, counted first in SQL, so 741 logins load one plain column.
//   7. `all` over no rows is not done (nothing was counted); `none` over no rows is.
//   8. `check(rule, { list: true })` also answers `found`, every row that passed (bounded by rows_most), so a caller can name
//      them (the refusal before a row asks the person for what their own arrivals already brought).
//
// Key concepts
//   rule    { over, match, tree, says }
//   check   { state, words, checked_at, says } (`says` is for the caller's reason; the card carries the first three)
//   readers { [reader name]: async (arg, names) → items | { items, fields } } (the owner's: src/person-store.mjs
//           doneWhenReaders); `arg` is what follows a source's prefix (list:<arg>), `names` what the rule named (named_by)
//

import data from './done-when-facts.json' with { type: 'json' };
import operatorData from '../parts/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { resolveRule, ruleVocabulary } from '../parts/formula-engine/rules/compile-rules.mjs';

const VOCABULARY = ruleVocabulary(operatorData);
const words = (key, values = {}) => data.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
/** One of the DATA's words with its blanks filled (the owner's reasons: Checked: ..., already done: ...). */
export const doneWords = words;
const at = (value, path) => path.reduce((held, key) => (held === null || held === undefined ? undefined : held[key]), value);
const present = value => value !== undefined && value !== null && value !== '';
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isGroup = node => isObject(node) && node.kind === 'group' && Array.isArray(node.rules);
const rulesIn = node => (isGroup(node) ? node.rules.flatMap(rulesIn) : [node]);

/** The source a rule's `over` names, with what follows its prefix, or null. */
export function sourceOf(over) {
  if (typeof over !== 'string') return null;
  if (data.sources[over] && !data.sources[over].prefix) return { id: over, def: data.sources[over], arg: null };
  for (const [id, def] of Object.entries(data.sources)) {
    if (def.prefix && over.startsWith(def.prefix) && over.length > def.prefix.length) return { id, def, arg: over.slice(def.prefix.length) };
  }
  return null;
}
/** Every id a rule may be over, as it is written. */
export const sourceIds = () => Object.entries(data.sources).map(([id, def]) => (def.prefix ? `${def.prefix}<${def.arg}>` : id));

/**
 * What a rule's answer depends on, when the store can say it has changed: the ids of the lists it reads (their write
 * counts, src/lists.mjs revisionOf), [] when only the rule's own words decide it, or null when the source lives outside
 * the store (devices, files, sign-ins, work), so the answer is asked every time.
 */
export function dependsOn(rule) {
  const source = isObject(rule) ? sourceOf(rule.over) : null;
  if (!source) return [];
  return source.def.revision === 'list' ? [source.arg] : null;
}

// The things a rule names for a source that looks only at those (named_by): its is_text and is_any_of tests on that field.
function namesIn(tree, field) {
  if (!field) return [];
  const names = rulesIn(tree).filter(rule => rule?.field === field).flatMap(rule => (rule.operator === 'is_text' ? [rule.params?.text] : rule.operator === 'is_any_of' ? rule.params?.values ?? [] : []));
  return [...new Set(names.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))].slice(0, 100);
}

// One field's value from an item, as its spec in the DATA says (see src/done-when-facts.json _what).
function read(item, spec) {
  if (Array.isArray(spec)) return spec.map(path => at(item, path)).find(present);
  if (Object.hasOwn(spec, 'value')) return spec.value;
  const value = spec.path.map(path => at(item, path)).find(present) ?? spec.default;
  if (spec.as === 'boolean') return Object.hasOwn(spec, 'equals') ? String(value ?? '').toLowerCase() === String(spec.equals).toLowerCase() : value === true || String(value).toLowerCase() === 'true';
  if (spec.as === 'ms') return typeof value === 'number' ? value : Number.isFinite(Date.parse(value ?? '')) ? Date.parse(value) : null;
  if (spec.as === 'number') return Number.isFinite(Number(value)) && present(value) ? Number(value) : null;
  return value;
}

// A reader's answer as rows and the fields the rule may name.
function project(def, answer, known = []) {
  const items = Array.isArray(answer) ? answer : answer?.items ?? [];
  const fields = [...def.fields];
  const add = field => { if (!fields.some(have => have.id === field.id)) fields.push(field); };
  for (const field of known) add(field);
  for (const field of Array.isArray(answer) ? [] : answer?.fields ?? []) add(field);
  const rows = items.map(item => {
    if (def.flat) return item;
    const row = Object.fromEntries(Object.entries(def.row).map(([id, spec]) => [id, read(item, spec) ?? null]));
    for (const [name, value] of Object.entries(def.spread ? at(item, def.spread.path) ?? {} : {})) {
      if (!Object.hasOwn(row, name)) { row[name] = value; add({ id: name, kind: def.spread.kind }); }
    }
    return row;
  });
  return { rows, fields };
}

// Decides within `seconds`, or answers that it did not; the timer never outlives the answer.
async function within(seconds, work) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(words('too_slow', { seconds })), { slow: true })), seconds * 1000); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

/**
 * readers:    the owner's reads (see Key concepts).
 * filterRows: the formula engine's row filter ({ tree, fields, rows } → { matches, incomplete }).
 * redact:     text → text with nothing secret in it (an error's words).
 * seconds:    the bound of one check (the DATA's check_seconds unless a test shortens it).
 */
export function makeDoneWhen({ readers, filterRows, now = () => Date.now(), redact = text => text, seconds = data.check_seconds, retry = data.retry_seconds }) {
  const slow = new Map();
  const answer = (state, text, extra = {}) => ({ state, words: text, checked_at: new Date(now()).toISOString(), ...extra });

  /** The plain words refusing a rule that cannot be checked, or null when it can. The rule is whatever was written. */
  async function refusal(rule) {
    const source = isObject(rule) ? sourceOf(rule.over) : null;
    if (!source) return words('bad_over', { over: isObject(rule) ? String(rule.over ?? '') : '', allowed: sourceIds().join(', ') });
    const { def } = source;
    let fields = [...def.fields];
    if (def.fields_reader) {
      const found = await Promise.resolve(readers[def.fields_reader](source.arg)).catch(() => null);
      if (!found) return words('bad_list', { over: rule.over });
      fields = [...fields, ...found.filter(field => !fields.some(have => have.id === field.id))];
    }
    if (!data.matches.some(match => match.id === rule.match)) return words('bad_match', { match: String(rule.match ?? ''), allowed: data.matches.map(match => match.id).join(', ') });
    if (typeof rule.says !== 'string' || !rule.says.trim() || rule.says.length > data.says_chars) return words('bad_says', { chars: data.says_chars });
    const tests = isGroup(rule.tree) ? rulesIn(rule.tree) : [];
    if (!tests.length || tests.length > data.rules_most || tests.some(test => !isObject(test) || (test.kind !== 'rule'))) return words('bad_tree', { most: data.rules_most });
    // A source of device facts (spread) has the fields the devices report, so a rule may name any of them as text.
    if (def.spread) for (const test of tests) if (typeof test.field === 'string' && !fields.some(have => have.id === test.field)) fields.push({ id: test.field, kind: def.spread.kind });
    const byId = new Map(fields.map(field => [field.id, field]));
    for (const test of tests) {
      const field = byId.get(test.field);
      if (!field) return words('bad_field', { field: String(test.field ?? ''), over: rule.over, fields: fields.map(have => `${have.id} (${have.kind})`).join(', ') });
      const operator = VOCABULARY.operators.get(test.operator);
      if (!operator || !operator.applies_to.includes(field.kind)) {
        return words('bad_operator', { operator: String(test.operator ?? ''), field: field.id, kind: field.kind, allowed: VOCABULARY.operatorsFor(field.kind).map(have => have.id).join(', ') });
      }
      if (!resolveRule(test, byId, VOCABULARY)) return words('bad_params', { field: field.id, operator: operator.id, input: operator.input });
    }
    if (def.named_by && !namesIn(rule.tree, def.named_by).length) return words('needs_names', { field: def.named_by, over: rule.over, noun: def.noun });
    return null;
  }

  /** How one row's rule stands now. `memo` shares a source's read inside one pass; `fresh` asks even a source that was too slow lately. */
  async function check(rule, { memo = new Map(), fresh = false, list = false } = {}) {
    if (!isObject(rule)) return answer('cannot_check', words('no_rule'));
    const source = sourceOf(rule.over);
    if (!source || !isGroup(rule.tree) || !data.matches.some(match => match.id === rule.match)) return answer('cannot_check', words('unknown_source', { over: String(rule.over ?? '') }));
    const { def } = source;
    const says = String(rule.says ?? '').trim();
    const names = namesIn(rule.tree, def.named_by);
    // The fields the rule names: a source with `columns` reads only those (a login's sealed values are never loaded).
    const needs = [...new Set(rulesIn(rule.tree).map(test => test?.field).filter(field => typeof field === 'string'))].sort();
    const key = `${rule.over}\n${names.join('\n')}${def.columns ? `\n${needs.join(',')}` : ''}`;
    const failed = reason => answer('failed', words('failed', { reason: redact(String(reason)).replace(/[.\s]+$/, '').slice(0, 160), seconds: retry }), { says });
    if (!fresh && (slow.get(key) ?? 0) > now()) return failed(words('too_slow', { seconds }));
    try {
      const outcome = await within(seconds, (async () => {
        if (!memo.has(key)) { const reading = Promise.resolve().then(() => readers[def.reader](source.arg, names, needs)); reading.catch(() => {}); memo.set(key, reading); }
        // A family of sources (a list) says its fields apart from its rows, read the same way.
        if (def.fields_reader && !memo.has(`${key}\nfields`)) { const reading = Promise.resolve().then(() => readers[def.fields_reader](source.arg)); reading.catch(() => {}); memo.set(`${key}\nfields`, reading); }
        const read = await memo.get(key);
        const held = (Array.isArray(read) ? read : read?.items ?? []).length;
        if (held > data.rows_most) throw new Error(words('too_many', { count: held }));
        const { rows, fields } = project(def, read, def.fields_reader ? (await memo.get(`${key}\nfields`)) ?? [] : []);
        return { total: rows.length, rows, ...(await filterRows({ tree: rule.tree, fields, rows })) };
      })());
      slow.delete(key);
      const unfinished = (outcome.incomplete ?? [])[0];
      if (unfinished) return answer('cannot_check', words('unfinished', { why: `${unfinished.field} ${unfinished.operator}` }), { says });
      const passing = (outcome.matches ?? []).length;
      const good = rule.match === 'none' ? outcome.total - passing : passing;
      const done = rule.match === 'all' ? outcome.total > 0 && passing === outcome.total : rule.match === 'any' ? passing > 0 : passing === 0;
      // `list` (a caller that names what passed, such as the refusal before a row asks the person for facts, src/waiting-filing.mjs
      // rowArrivalsRefusal) also gets every row that passed, projected to the source's fields (the filter answers indices).
      return answer(done ? 'done' : 'not_yet', words('counts', { good, total: outcome.total, says }), { says, ...(list ? { found: (outcome.matches ?? []).map(index => outcome.rows[index]) } : {}) });
    } catch (error) {
      if (error?.slow) slow.set(key, now() + retry * 1000);
      return failed(error?.message ?? error);
    }
  }

  /** Every row's check at once, bounded as one: Map(row id → check). `hasDevice(row)` says a row waits on a device's report. */
  async function checkRows(rows, { fresh = false, hasDevice = () => false } = {}) {
    const memo = new Map();
    const checks = await Promise.all(rows.map(async row => {
      const rule = row.values?.done_when_rule;
      if (isObject(rule)) return [row.id, await check(rule, { memo, fresh })];
      return [row.id, hasDevice(row) ? answer('not_yet', words('device')) : answer('cannot_check', words('no_rule'))];
    }));
    return new Map(checks);
  }

  return { refusal, check, checkRows };
}
