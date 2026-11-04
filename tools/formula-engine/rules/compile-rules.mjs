// packages/formula-engine/rules/compile-rules.mjs
//
// Purpose
//   Turn a person's filter (a tree of rules and groups) into ONE
//   composition-ast binding the formula engine evaluates. The meaning of each
//   comparison lives in rule-operators.json as a binding template; this file
//   only fills templates and nests groups. It never compares a value itself.
//
// Rule tree (plain JSON, the same shape a saved view stores)
//   group: {kind:"group", combinator:<combinator id>, negate:boolean, rules:[node]}
//   rule:  {kind:"rule", field:<field id>, operator:<operator id>, params:{...}}
//   params by operator input: values:{values:[...]}, value:{value}, text:{text},
//   range:{min?, max?}, none:{}.
//
// Non-negotiable invariants
//   - A rule the person has not finished (unknown field or operator, missing
//     params) is left out and reported in `incomplete`, never guessed.
//   - An empty tree compiles to `binding: null`, which means "every row".
//   - Every group binding selects the row itself before combining, so each
//     nested rule reads the row, never an intermediate value.
//   - No field, operator or combinator id is named in this file.

const ROW = {'$kind': 'binding', select: {from: 'self'}};

const isGroup = node => node && node.kind === 'group';
const present = value => value !== undefined && value !== null && value !== '';

/** Everything a caller needs to show and compile rules, looked up once. */
export function ruleVocabulary(operatorData) {
  const operators = new Map(operatorData.operators.map(row => [row.id, row]));
  const combinators = new Map(operatorData.combinators.map(row => [row.id, row]));
  return {
    operators,
    combinators,
    operatorsFor: kind => operatorData.operators.filter(row => row.applies_to.includes(kind)),
    firstCombinator: operatorData.combinators[0]?.id,
  };
}

function fill(template, field, params, fieldParams) {
  if (Array.isArray(template)) return template.map(item => fill(item, field, params, fieldParams));
  if (!template || typeof template !== 'object') return template;
  if (Object.hasOwn(template, '$field')) return field[template.$field];
  if (Object.hasOwn(template, '$param')) return params[template.$param];
  if (Object.hasOwn(template, '$field_param')) {
    const other = fieldParams[template.$field_param];
    return other.path || [other.id];
  }
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, field, params, fieldParams)]));
}

function combine(op, members) {
  return {...ROW, transform: [{op, args: {values: members}}]};
}

function negated(binding) {
  return {...binding, transform: [...(binding.transform || []), {op: 'op:core.not'}]};
}

function normalizedParams(operator, params) {
  const lower = operator.param_case === 'lower';
  const shape = value => (lower && typeof value === 'string' ? value.toLocaleLowerCase() : value);
  return Object.fromEntries(Object.entries(params || {}).map(([key, value]) => [
    key, Array.isArray(value) ? value.map(shape) : shape(value),
  ]));
}

function ready(operator, params) {
  if (operator.input === 'none') return true;
  // A comparison repeated for each entry of a list param (tags, words) is
  // ready once the list holds one entry.
  if (operator.each) return Array.isArray(params[operator.each.param]) && params[operator.each.param].length > 0;
  if (operator.input === 'values') return Array.isArray(params.values) && params.values.length > 0;
  // A comparison made of parts (a range, a day) is ready once any part is.
  if (operator.parts) return operator.parts.some(part => present(params[part.when]));
  if (operator.input === 'text') return typeof params.text === 'string' && params.text.trim() !== '';
  return present(params.value);
}

/**
 * The field, operator and normalized params a rule means, or null when the
 * rule is not finished (unknown field or operator, a comparison the field's
 * kind does not offer, missing params). The one place that decides which
 * rules count, shared by every evaluator of a rule tree.
 */
export function resolveRule(rule, fieldsById, vocabulary) {
  const field = fieldsById.get(rule.field);
  const operator = vocabulary.operators.get(rule.operator);
  if (!field || !operator || !operator.applies_to.includes(field.kind)) return null;
  const params = normalizedParams(operator, rule.params);
  if (!ready(operator, params)) return null;
  // A comparison may name another field through DATA. Validate and retain that
  // field just as the primary one; an absent or unlike-kind field is unfinished.
  const fieldParams = {};
  for (const name of operator.field_params || []) {
    const other = fieldsById.get(params[name]);
    if (!other || other.kind !== field.kind) return null;
    fieldParams[name] = other;
  }
  return {field, operator, params, fieldParams};
}

function compileRule(rule, fieldsById, vocabulary) {
  const resolved = resolveRule(rule, fieldsById, vocabulary);
  if (!resolved) return null;
  const {field, operator, params, fieldParams} = resolved;
  const target = {path: field.path || [field.id]};
  let binding;
  if (operator.each) {
    const copies = params[operator.each.param].map(entry => fill(operator.binding, target, {...params, [operator.each.as]: entry}, fieldParams));
    binding = copies.length === 1 ? copies[0] : combine(operator.each.combine, copies);
  } else if (operator.parts) {
    const parts = operator.parts.filter(part => present(params[part.when])).map(part => fill(part.binding, target, params, fieldParams));
    binding = parts.length === 1 ? parts[0] : combine(operator.combine, parts);
  } else {
    binding = fill(operator.binding, target, params, fieldParams);
  }
  return {binding: operator.negate ? negated(binding) : binding, reads: [field.id, ...Object.values(fieldParams).map(other => other.id)]};
}

/**
 * Compile a rule tree. Returns {binding, reads, incomplete}: `binding` is null
 * when nothing constrains the rows; `reads` lists the field ids the binding
 * reads (a host can skip building facts nobody asked about); `incomplete`
 * lists the rules left out because they are not finished.
 */
export function compileRules(tree, {fields, vocabulary}) {
  const fieldsById = new Map(fields.map(field => [field.id, field]));
  const reads = new Set();
  const incomplete = [];
  const visit = node => {
    if (isGroup(node)) {
      const members = (node.rules || []).map(visit).filter(Boolean);
      if (!members.length) return null;
      const combinator = vocabulary.combinators.get(node.combinator) || vocabulary.combinators.get(vocabulary.firstCombinator);
      const joined = members.length === 1 && !node.negate ? members[0] : combine(combinator.op, members);
      return node.negate ? negated(joined) : joined;
    }
    const compiled = compileRule(node, fieldsById, vocabulary);
    if (compiled) for (const field of compiled.reads) reads.add(field);
    else incomplete.push(node);
    return compiled?.binding ?? null;
  };
  const binding = tree ? visit(tree) : null;
  return {binding, reads: [...reads], incomplete};
}

/** An empty group with the vocabulary's first combinator. */
export function emptyRuleGroup(vocabulary) {
  return {kind: 'group', combinator: vocabulary.firstCombinator, negate: false, rules: []};
}
