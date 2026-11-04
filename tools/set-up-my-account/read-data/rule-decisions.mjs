// One rules owner for matching, lifetime and effect precedence. Callers prepare their facts and
// conditions, then interpret the selected effects for their own boundary (visibility or access).
// Display effects never grant access: an access caller declares allow/deny effects and remains the
// only place that turns those effects into an authorization result.

const treeCache = new Map();
const resultCache = new WeakMap();

const group = rules => ({ kind: 'group', combinator: 'and', negate: false, rules });
const conditionFor = entry => entry.when ?? entry.rule?.when ?? null;
const timeOf = value => value == null ? null : typeof value === 'number' ? value : Date.parse(value);
const leaves = tree => tree?.kind === 'group' ? (tree.rules ?? []).flatMap(leaves) : [tree];

function attributedProblems(problems, tree, entries) {
  return problems.flatMap(problem => {
    if (problem?.rule || !problem || typeof problem !== 'object') return [problem];
    // The formula owner returns the unfinished leaf. Its containing branch carries
    // the originating rule identity, even when another rule names the same field.
    const owners = tree.rules.flatMap((branch, index) => leaves(branch).some(leaf => leaf === problem ||
      leaf && Object.keys(problem).every(key => JSON.stringify(leaf[key]) === JSON.stringify(problem[key])))
      ? [entries[index].rule.id] : []);
    return owners.length ? owners.map(rule => ({ ...problem, rule })) : [problem];
  });
}

function cachedTree(entries, fields, ruleField) {
  const key = JSON.stringify({ fields, ruleField, entries: entries.map(({ rule, when }) => [rule.id, when]) });
  let cached = treeCache.get(key);
  if (cached) return cached;
  const tree = {
    kind: 'group', combinator: 'or', negate: false,
    rules: entries.map(({ rule, when }) => group([
      { kind: 'rule', field: ruleField.id, operator: 'is_any_of', params: { values: [rule.id] } },
      ...(when ? [when] : []),
    ])),
  };
  cached = { tree, fields: [ruleField, ...fields] };
  treeCache.set(key, cached);
  if (treeCache.size > 128) treeCache.delete(treeCache.keys().next().value);
  return cached;
}

/**
 * Evaluate current rules and resolve their strongest declared effects.
 *
 * entries: [{ rule, row, when? }], where `when` defaults to rule.when.
 * effects: DATA rows { id, strength, changes? }.
 * fields: formula fields shared by all prepared rows; ruleField is the private rule-id selector.
 * filterRows: the formula engine row filter.
 * now: milliseconds; expired or malformed-until rules fail closed and do not participate.
 * strict: if the formula owner reports an incomplete tree, matched entries are refused.
 * isolateIncomplete: presentation callers may retain independent complete rules when every unfinished leaf
 * is attributed to its rule. Access callers keep whole-answer refusal; unattributed problems always refuse all.
 */
export function decideRuleEffects({ entries, effects, fields, ruleField = { id: '__policy_rule_id', kind: 'choice' }, filterRows, now, strict = false, isolateIncomplete = false }) {
  const effectRows = new Map((effects ?? []).map(effect => [effect.id, effect]));
  const current = (entries ?? []).filter(entry => {
    if (!effectRows.has(entry?.rule?.effect)) return false;
    const until = timeOf(entry.rule.until);
    return entry.rule.until == null || Number.isFinite(until) && until > now;
  });
  if (!current.length) return { held: [], winners: [], changes: [], incomplete: [], malformed: false };

  const { tree, fields: ruleFields } = cachedTree(current.map(entry => ({ ...entry, when: conditionFor(entry) })), fields, ruleField);
  const rows = current.map(entry => ({ ...(entry.row ?? {}), [ruleField.id]: entry.rule.id }));
  const finish = answer => {
    const valid = Array.isArray(answer?.matches) && answer.matches.every(index => Number.isInteger(index) && index >= 0 && index < current.length)
      && (!strict || new Set(answer.matches).size === answer.matches.length);
    const incomplete = Array.isArray(answer?.incomplete) ? attributedProblems(answer.incomplete, tree, current) : [];
    const malformed = !valid || strict && !Array.isArray(answer?.incomplete);
    const indexes = valid && !malformed ? new Set(answer.matches) : new Set();
    const unfinishedRules = new Set(incomplete.map(problem => problem?.rule).filter(Boolean));
    const isolate = isolateIncomplete && incomplete.every(problem => problem?.rule);
    const held = current.filter((entry, index) => indexes.has(index) && !(strict && incomplete.length &&
      (!isolate || unfinishedRules.has(entry.rule.id))));
    const changes = held.filter(entry => effectRows.get(entry.rule.effect)?.changes === true);
    const decisive = held.filter(entry => effectRows.get(entry.rule.effect)?.changes !== true);
    const strength = decisive.reduce((highest, entry) => Math.max(highest, effectRows.get(entry.rule.effect).strength ?? 0), -Infinity);
    const winners = decisive.filter(entry => (effectRows.get(entry.rule.effect).strength ?? 0) === strength);
    return { held, winners, changes, incomplete, malformed };
  };
  let evaluators = resultCache.get(tree);
  if (!evaluators) resultCache.set(tree, evaluators = new WeakMap());
  let answers = evaluators.get(filterRows);
  if (!answers) evaluators.set(filterRows, answers = new Map());
  const cacheKey = JSON.stringify(rows);
  let answer = answers.get(cacheKey);
  if (!answer) {
    answer = filterRows({ tree, fields: ruleFields, rows });
    if (answer && typeof answer.then === 'function') {
      answer = answer.then(value => {
        answers.set(cacheKey, value);
        return value;
      }, error => {
        // A temporary owner failure says nothing about these rules. Preserve
        // refusal for this call and let the same current facts retry the owner.
        if (answers.get(cacheKey) === answer) answers.delete(cacheKey);
        throw error;
      });
    }
    answers.set(cacheKey, answer);
    if (answers.size > 2000) answers.clear();
  }
  return answer && typeof answer.then === 'function' ? answer.then(finish) : finish(answer);
}
