// packages/ui/show/rule-filter/rule-tree.ts
//
// Purpose
//   The shape of a person's filter (a tree of rules and groups) and the pure,
//   path-copying edits the filter controls make to it. The tree is the same
//   plain JSON the formula engine compiles (formula-engine/rules/compile-rules.mjs),
//   so what a person builds here is exactly what gets evaluated and saved.
//
// Non-negotiable invariants
//   - No comparison is ever made here. Deciding which records match belongs to
//     the formula engine; this file only edits the tree.
//   - Every edit returns a new tree that shares every untouched branch with the
//     old one (path copy), so a caller can compare branches by identity.
//   - Operators and combinators are DATA rows (formula-engine
//     rules/rule-operators.json). Nothing here names one.

export type RuleOperator = {
  id: string
  label: string
  /** Short wording for a chip ("is", ">", "between"). */
  chip?: string
  icon?: string
  /** What the person supplies: none, value, values, words, text, day or range. */
  input: string
  /** Field kinds that offer this comparison, in menu order. */
  applies_to: string[]
  /** The comparison keeps what its template does NOT match ("is none of"). */
  negate?: boolean
}

/** `op` names the formula-engine operation the combinator compiles to (op:core.and for All). */
export type RuleCombinator = {id: string; label: string; sentence: string; op?: string}

export type RuleOperatorData = {operators: RuleOperator[]; combinators: RuleCombinator[]}

export type Rule = {kind: 'rule'; field: string; operator: string; params: Record<string, unknown>}
export type RuleGroup = {kind: 'group'; combinator: string; negate: boolean; rules: RuleNode[]}
export type RuleNode = Rule | RuleGroup

/** Indices from the root group down to one node. */
export type RulePath = readonly number[]

export const isGroup = (node: RuleNode | null | undefined): node is RuleGroup => node?.kind === 'group'

export const operatorsFor = (data: RuleOperatorData, kind: string | undefined) =>
  data.operators.filter(operator => kind !== undefined && operator.applies_to.includes(kind))

export const operatorById = (data: RuleOperatorData, id: string) =>
  data.operators.find(operator => operator.id === id)

export const combinatorById = (data: RuleOperatorData, id: string) =>
  data.combinators.find(combinator => combinator.id === id) ?? data.combinators[0]

export const emptyGroup = (data: RuleOperatorData): RuleGroup =>
  ({kind: 'group', combinator: data.combinators[0]?.id ?? '', negate: false, rules: []})

/** A new rule on `field`, starting on its first comparison. */
export function newRule(data: RuleOperatorData, field?: {id: string; kind?: string}): Rule {
  const operator = field ? operatorsFor(data, field.kind)[0] : undefined
  return {kind: 'rule', field: field?.id ?? '', operator: operator?.id ?? '', params: {}}
}

/** The params worth keeping when a rule moves to another comparison: values
 *  stay values, text stays text, a range stays a range. */
export function carryParams(from: RuleOperator | undefined, to: RuleOperator | undefined, params: Record<string, unknown>) {
  return from && to && from.input === to.input ? params : {}
}

export function nodeAt(root: RuleGroup, path: RulePath): RuleNode | undefined {
  let node: RuleNode | undefined = root
  for (const index of path) node = isGroup(node) ? node.rules[index] : undefined
  return node
}

/** Replace the node at `path` (null removes it), copying only its ancestors. */
export function replaceAt(root: RuleGroup, path: RulePath, next: RuleNode | null): RuleGroup {
  if (!path.length) return next && isGroup(next) ? next : root
  const [index, ...rest] = path
  const child = root.rules[index]
  const replaced = rest.length ? (isGroup(child) ? replaceAt(child, rest, next) : child) : next
  const rules = replaced === null
    ? root.rules.filter((_node, at) => at !== index)
    : root.rules.map((node, at) => (at === index ? replaced : node))
  return {...root, rules}
}

export const appendAt = (root: RuleGroup, path: RulePath, node: RuleNode): RuleGroup => {
  const group = nodeAt(root, path)
  return isGroup(group) ? replaceAt(root, path, {...group, rules: [...group.rules, node]}) : root
}

/** A copy of the node at `path` placed right after it. */
export function duplicateAt(root: RuleGroup, path: RulePath): RuleGroup {
  const node = nodeAt(root, path)
  const parent = nodeAt(root, path.slice(0, -1))
  if (!node || !isGroup(parent)) return root
  const at = path[path.length - 1]
  return replaceAt(root, path.slice(0, -1), {...parent, rules: [...parent.rules.slice(0, at + 1), structuredClone(node), ...parent.rules.slice(at + 1)]})
}

/** The node at `path` moved inside a new group of its own, ready for siblings. */
export function wrapAt(root: RuleGroup, path: RulePath, data: RuleOperatorData): RuleGroup {
  const node = nodeAt(root, path)
  return node ? replaceAt(root, path, {kind: 'group', combinator: data.combinators[0]?.id ?? '', negate: false, rules: [node]}) : root
}

/** How many rules the tree holds, at any depth. */
// A line still waiting for its field decides nothing, so it is not counted:
// the Filter badge, the chip row and every "is anything filtered" question
// read this one count.
export const countRules = (node: RuleNode): number =>
  isGroup(node) ? node.rules.reduce((sum, child) => sum + countRules(child), 0) : node.field ? 1 : 0

/**
 * Add or remove one value on a top-level multi-value rule for `field`, the way
 * a click on a tag in the table narrows by it. The first comparison the field
 * offers that takes a list of values is used. The rule is removed when its
 * last value goes.
 */
export function toggleValue(root: RuleGroup, data: RuleOperatorData, field: {id: string; kind?: string}, value: string, operatorId?: string): RuleGroup {
  const listing = operatorsFor(data, field.kind).filter(candidate => candidate.input === 'values')
  const operator = listing.find(candidate => candidate.id === operatorId) ?? listing.find(candidate => !candidate.negate) ?? listing[0]
  if (!operator) return root
  // One top-level list rule per field: picking keeps or hides values through
  // whichever of the field's list comparisons it already uses.
  const index = root.rules.findIndex(node => !isGroup(node) && node.field === field.id && listing.some(candidate => candidate.id === node.operator))
  if (index < 0) return appendAt(root, [], {kind: 'rule', field: field.id, operator: operator.id, params: {values: [value]}})
  const rule = root.rules[index] as Rule
  const values = Array.isArray(rule.params.values) ? rule.params.values.map(String) : []
  const next = values.includes(value) ? values.filter(held => held !== value) : [...values, value]
  return replaceAt(root, [index], next.length ? {...rule, operator: operatorId ? operator.id : rule.operator, params: {...rule.params, values: next}} : null)
}

/** Whether a top-level multi-value rule on `field` holds `value`. */
export function holdsValue(root: RuleGroup, fieldId: string, value: string): boolean {
  return root.rules.some(node => !isGroup(node) && node.field === fieldId && Array.isArray(node.params.values)
    && node.params.values.some(held => String(held).toLocaleLowerCase() === value.toLocaleLowerCase()))
}

/** A tree read back from storage, or an empty group when it is not one. */
export function readRuleTree(value: unknown, data: RuleOperatorData): RuleGroup {
  const valid = (node: any): node is RuleNode => node && typeof node === 'object' && (
    (node.kind === 'group' && typeof node.combinator === 'string' && Array.isArray(node.rules) && node.rules.every(valid))
    || (node.kind === 'rule' && typeof node.field === 'string' && typeof node.operator === 'string' && node.params && typeof node.params === 'object'))
  return valid(value) && isGroup(value) ? {...value, negate: value.negate === true} : emptyGroup(data)
}
