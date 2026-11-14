// parts/formula-engine/rules/filter-rows-by-rules.mjs
//
// Purpose
//   The formula engine's row filter as one call: a rule tree, the fields it
//   may name ({id, kind}) and plain rows go in; the indices of the rows the
//   rules hold for come out, with the rules that were left out because they
//   are unfinished. It is the Workshop tool tool:filter-rows-by-rules
//   (records/workshop-engine-tool-records.json).
//
// Non-negotiable invariants
//   - compile-rules.mjs turns the tree into one binding and the compiled
//     evaluator decides every row; this file reads nothing itself.
//   - A row's field value is `row[field.id]`; a missing value is null, which no
//     comparison matches.
//   - An empty tree (or one with only unfinished rules) keeps every row.
//   - The evaluator's bytes come from the host (`wasm()`), a compiled
//     WebAssembly.Module where code generation is forbidden (a Worker).
//   - `load()` loads the evaluator once; after it resolves, `filterRowsByRulesNow`
//     answers in the same call (a page deciding a card while it is emitted), and
//     before it, it throws rather than answering without the rules.
//   - A rule (its tree and fields, by value) is compiled once, and each row's
//     answer under it is kept: a compiled rule reads only the row and its own
//     literals, so the same row always gets the same answer. Callers that read
//     their rules afresh for every decision (an account's budgets on each
//     reservation) no longer ask the evaluator to parse the rule again.

import {compileRules, ruleVocabulary} from './compile-rules.mjs';
import {loadRowEvaluator} from './evaluate-over-rows.mjs';


/** Every field a tree names, once each, as the compiler wants them: [{id, kind}]. A rule's `field` is the fact's name
 *  (any text, a path such as "/a/b" included); its optional `field_kind` (default `fact`) picks the
 *  comparisons it offers (rule-operators.json `applies_to`). */
export function fieldsOfTree(tree) {
  const found = new Map();
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'group') {
      for (const rule of node.rules || []) visit(rule);
    } else if (node.field !== undefined && node.field !== null && !found.has(node.field)) {
      found.set(node.field, {id: node.field, kind: node.field_kind || 'fact'});
    }
  };
  visit(tree);
  return [...found.values()];
}

// The comparison a short-spelling test names, by the first of its keys that is there.
function comparisonOfTest(test, present) {
  if (test.present && present === 'is_not_empty') return ['is_not_empty', {}];
  if ('equals' in test) return test.equals === undefined || test.equals === null ? ['is_unknown', {}] : ['equals', {value: test.equals}];
  if ('one_of' in test) return ['is_any_of', {values: test.one_of}];
  if ('starts_with' in test) return ['begins_with', {text: test.starts_with}];
  if ('present' in test) return [test.present ? 'is_known' : 'is_unknown', {}];
  return ['no_comparison_named', {}];
}

/** The rule tree (all must hold) of a list of tests in the short spelling data files use: `{path, equals | one_of |
 *  starts_with | present, not}`. A rule's field is `JSON.stringify(path)` (JSON.parse it to find the fact); `not` negates
 *  that test; a test that names none of the comparisons is left unfinished, which `holdsNow` refuses. `present` says what
 *  "present" means: `is_known` (not null) or `is_not_empty` (not null and not ''). */
export function ruleTreeOfTests(tests, {present = 'is_known'} = {}) {
  const rules = (tests || []).map(test => {
    const [operator, params] = comparisonOfTest(test, present);
    const rule = {kind: 'rule', field: JSON.stringify(test.path), operator, params};
    return test.not ? {kind: 'group', combinator: 'and', negate: true, rules: [rule]} : rule;
  });
  return {kind: 'group', combinator: 'and', negate: false, rules};
}

/** operators: rule-operators.json; wasm: () → the evaluator's module or bytes, or a promise of them. */
export function makeRowFilter({operators, wasm}) {
  const vocabulary = ruleVocabulary(operators);
  let evaluator = null;
  // Rule text -> {compiled, answers: row text -> kept}. Both bounded; the oldest goes first.
  const rules = new Map();
  const remember = (map, key, value, most) => {
    map.set(key, value);
    while (map.size > most) map.delete(map.keys().next().value);
    return value;
  };
  // Decides with the evaluator already loaded, in the same call (a page deciding one notice while it is emitted).
  function decide(input) {
    const fields = Array.isArray(input?.fields) ? input.fields : [];
    const rows = Array.isArray(input?.rows) ? input.rows : [];
    const tree = input?.tree && typeof input.tree === 'object' ? input.tree : {kind: 'group', rules: []};
    const ruleKey = JSON.stringify([tree, fields]);
    const rule = rules.get(ruleKey) ?? remember(rules, ruleKey, {compiled: compileRules(tree, {fields, vocabulary}), answers: new Map()}, 512);
    const {binding, reads, incomplete} = rule.compiled;
    const read = fields.filter(field => reads.includes(field.id));
    const table = rows.map(row => Object.fromEntries(read.map(field => [field.id, row?.[field.id] ?? null])));
    const keys = table.map(row => JSON.stringify(row));
    const answers = new Map(keys.map(key => [key, rule.answers.get(key)]));
    const asked = [...answers.keys()].filter(key => answers.get(key) === undefined);
    if (asked.length) {
      const rowOf = new Map(keys.map((key, index) => [key, table[index]]));
      const hit = new Set(evaluator.filterRows(asked.map(key => rowOf.get(key)), binding).matches);
      asked.forEach((key, index) => answers.set(key, remember(rule.answers, key, hit.has(index), 4096)));
    }
    const matches = keys.flatMap((key, index) => answers.get(key) ? [index] : []);
    return {matches, kept: matches.length, incomplete};
  }
  /** Loads the evaluator once; after it resolves, filterRowsByRulesNow answers in the same call. */
  async function load() {
    evaluator ??= loadRowEvaluator(await wasm());
  }
  /** input: {tree, fields: [{id, kind}], rows: [object]} → {matches: [index], kept: number, incomplete: [...]} */
  async function filterRowsByRules(input) {
    await load();
    return decide(input);
  }
  /** The same answer without waiting, once `load()` has resolved; before that it throws, never guesses. */
  function filterRowsByRulesNow(input) {
    if (!evaluator) throw new Error('The rule evaluator is not loaded yet.');
    return decide(input);
  }
  /** Whether a rule tree holds over ONE set of facts (an event's fields, a transcript row, a screen's state at one
   *  element), in the same call once `load()` has resolved. `facts` is an object keyed by the rules' `field`, or a
   *  function of it. A fact nobody gave is null. An empty or missing tree holds; a tree with a rule the engine could not
   *  finish is refused with the rule named, never read as holding. The engine decides every comparison. */
  function holdsNow(tree, facts) {
    if (!tree) return true;
    const fields = fieldsOfTree(tree);
    if (!fields.length) return true;
    const read = typeof facts === 'function' ? facts : id => facts?.[id];
    const row = Object.fromEntries(fields.map(field => [field.id, read(field.id) ?? null]));
    const {matches, incomplete} = decide({tree, fields, rows: [row]});
    if (incomplete.length) throw new Error(`The rule engine could not finish a condition: ${JSON.stringify(incomplete[0])}.`);
    return matches.length === 1;
  }
  /** The same formula evaluator used by rows also resolves a view's changing
   *  time boundary against its read-time clock and explicitly named records. */
  async function evaluateBinding({binding, input}) {
    if (!binding || typeof binding !== 'object') throw new Error('A formula binding is required.');
    await load();
    return {value: evaluator.evaluate(binding, input ?? {})};
  }
  return {filterRowsByRules, filterRowsByRulesNow, holdsNow, evaluateBinding, load};
}
