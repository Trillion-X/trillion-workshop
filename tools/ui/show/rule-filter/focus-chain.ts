// packages/ui/show/rule-filter/focus-chain.ts
//
// Purpose
//   One filter at every level. A person can narrow the whole app ("Focus: the
//   launch pursuit"), one arrangement, one container, one screen, one view,
//   one record group or one field, and every level is the same rule tree the
//   rule filter edits. A list shows only records that pass its own rule AND
//   every rule above it on its path, root first.
//
// Non-negotiable invariants
//   1. The evaluator is blind to levels: a path is a list of node ids and the
//      effective rule is the AND of the rules stored under those ids. No id,
//      level name or field name is known here.
//   2. A rule that reads a field a list does not hold never hides that list's
//      records: that link is reported as not narrowing, whole (half of an Any
//      group would change its meaning), and the rest still apply.
//   3. One stored record holds every node's rule (label FOCUS_CHAIN_LABEL), so
//      adding a level never adds a record kind.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import {countRules, isGroup, type RuleGroup, type RuleNode, type RuleOperatorData} from './rule-tree'

/** Every node's own rule, by node id. */
export type NodeRules = Readonly<Record<string, RuleGroup>>

/** One node on a path that holds a rule. */
export type ChainLink = {nodeId: string; rule: RuleGroup}

/** The label the person's rules are kept under in their own records. */
export const FOCUS_CHAIN_LABEL = 'rule-filter::focus-chain'

/** Every field a rule tree reads. */
export function fieldsRead(node: RuleNode, into: Set<string> = new Set()): Set<string> {
  if (isGroup(node)) for (const child of node.rules) fieldsRead(child, into)
  else into.add(node.field)
  return into
}

/** The links along a path that hold a rule that constrains something, root first. */
export function linksAlong(path: readonly string[], rules: NodeRules): ChainLink[] {
  return path.flatMap(nodeId => {
    const rule = rules[nodeId]
    return rule && countRules(rule) > 0 ? [{nodeId, rule}] : []
  })
}

/** The id of the combinator that means "all of these" (the one whose op is the
 *  core and), else the first, which rule-operators.json lists as All. */
export const allOf = (data: RuleOperatorData) =>
  data.combinators.find(combinator => combinator.op === 'op:core.and')?.id ?? data.combinators[0]?.id ?? ''

/** The one rule a list at the end of `path` applies: every link's rule under an
 *  All group, root first, leaving out (and naming) each link that reads a
 *  field this list cannot read. */
export function effectiveRule(path: readonly string[], rules: NodeRules, options: {all: string; canRead?: (fieldId: string) => boolean}): {rule: RuleGroup; applied: ChainLink[]; notNarrowing: ChainLink[]} {
  const applied: ChainLink[] = []
  const notNarrowing: ChainLink[] = []
  for (const link of linksAlong(path, rules)) {
    const readable = !options.canRead || [...fieldsRead(link.rule)].every(options.canRead)
    ;(readable ? applied : notNarrowing).push(link)
  }
  return {rule: {kind: 'group', combinator: options.all, negate: false, rules: applied.map(link => link.rule)}, applied, notNarrowing}
}

/** Where the rules live: the person's own records by default, anything with
 *  the same three calls in a test or another host. */
export type NodeRuleStore = {
  read: () => NodeRules
  write: (nodeId: string, rule: RuleGroup | null) => void
  subscribe: (listener: () => void) => () => void
}

/** A store held in memory, for a host that keeps nothing (and for tests). */
export function memoryNodeRules(start: NodeRules = {}): NodeRuleStore {
  let rules: NodeRules = start
  const listeners = new Set<() => void>()
  return {
    read: () => rules,
    write: (nodeId, rule) => {
      rules = withNodeRule(rules, nodeId, rule)
      for (const listener of listeners) listener()
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/** A node's own rule written into a stored whole, so every level writes the
 *  same record and a write never loses another level's rule. */
export function withNodeRule(rules: NodeRules, nodeId: string, rule: RuleGroup | null): NodeRules {
  const next = {...rules}
  if (rule && countRules(rule) > 0) next[nodeId] = rule
  else delete next[nodeId]
  return next
}
