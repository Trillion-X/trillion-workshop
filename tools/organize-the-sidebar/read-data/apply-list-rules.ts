// parts/sidebar/read-data/apply-list-rules.ts
//
// NO PRIOR: Trillion's own (the person's lists and rows that hold or show by a rule).
//
// PURPOSE
//   The person's own lists may carry the rules the app's lists carry in DATA: `holds: { rules }` (the list holds every
//   row the rule holds for), `order_by` ({ path, descending }: the order of those rows), `shown_when` (the list shows
//   only while its rule holds), and a row's place in a list may carry `shown_when` (that row shows there only while its
//   rule holds). They are kept in the list's own records (its meta and each member's presentation). This file reads
//   them out for the caller's decider (src/workspace/sidebar-rules.mjs decideSidebarRules, the formula engine) and lays
//   the answer over the lists. Pure: it decides nothing and reads no clock.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list, a row, a fact or a rule.
//   2. Until a decision arrives (`undecidedRules`) a list that shows by a rule is not shown, a row that shows by one is
//      not shown, and a list that holds by one holds nothing: nothing past its time flashes up first.
//   3. A list holding by a rule shows rows that also sit in their own lists; it takes none from any of them.

import type { SurfaceCollection, SurfaceCollectionMember } from './read-surface-collections'

/** What the decider answers: the rows each rule list holds, lists hidden, rows hidden in each list, next turn. */
export type DecidedListRules = {
  holds: Record<string, string[]>
  hidden: string[]
  hidden_rows: Record<string, string[]>
  next_change_at: number | null
}
/** One of the person's lists as the decider reads it. */
export type RuleList = {
  id: string
  made_at?: unknown
  holds?: { rules: unknown }
  shown_when?: unknown
  rows_shown_when?: Record<string, unknown>
}
export type OrderBy = { path: string[]; descending?: boolean }
type Row = Record<string, unknown> & { id: unknown }

const isTree = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const valueAt = (row: unknown, path: readonly string[]) => path.reduce<unknown>(
  (value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), row)
const rulesOf = (meta: Record<string, unknown>) => (isTree(meta.holds) && isTree(meta.holds.rules) ? meta.holds.rules : null)

/** Rows in the order a list names (`order_by`): by the value at its path, rows without one last. */
export function orderRows<T>(rows: readonly T[], order: OrderBy | undefined): T[] {
  if (!order || !Array.isArray(order.path)) return [...rows]
  const sign = order.descending ? -1 : 1
  const read = (row: T) => {
    const value = valueAt(row, order.path)
    const time = typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(time) ? time : value
  }
  return [...rows].sort((left, right) => {
    const a = read(left), b = read(right)
    if (a === b) return 0
    if (a === undefined || a === null) return 1
    if (b === undefined || b === null) return -1
    return (a < b ? -1 : 1) * sign
  })
}

/** Every list, at any depth, that carries a rule, as the decider reads it. */
export function ruleListsOf(collections: readonly SurfaceCollection[]): RuleList[] {
  const found: RuleList[] = []
  const seen = new Set<string>()
  const walk = (list: SurfaceCollection) => {
    if (seen.has(list.id)) return
    seen.add(list.id)
    const rows = Object.fromEntries(list.members
      .filter((member) => member.kind === 'surface' && isTree(member.presentation.shown_when))
      .map((member) => [member.surfaceId, member.presentation.shown_when]))
    const holds = rulesOf(list.meta)
    if (holds || isTree(list.meta.shown_when) || Object.keys(rows).length) {
      found.push({
        id: list.id,
        ...(list.meta.made_at !== undefined ? { made_at: list.meta.made_at } : {}),
        ...(holds ? { holds: { rules: holds } } : {}),
        ...(isTree(list.meta.shown_when) ? { shown_when: list.meta.shown_when } : {}),
        ...(Object.keys(rows).length ? { rows_shown_when: rows } : {}),
      })
    }
    for (const member of list.members) if (member.childCollection) walk(member.childCollection)
  }
  collections.forEach(walk)
  return found
}

/** The answer to give while the decider has not answered yet (invariant 2). */
export function undecidedRules(lists: readonly RuleList[]): DecidedListRules {
  return {
    holds: {},
    hidden: lists.filter((list) => list.shown_when).map((list) => list.id),
    hidden_rows: Object.fromEntries(lists.filter((list) => list.rows_shown_when).map((list) => [list.id, Object.keys(list.rows_shown_when!)])),
    next_change_at: null,
  }
}

/** The lists with the decision laid over them: hidden lists and rows gone, rule lists holding what was decided. */
export function applyDecidedRules(collections: readonly SurfaceCollection[], decided: DecidedListRules, rows: readonly Row[]): SurfaceCollection[] {
  const hidden = new Set(decided.hidden)
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  const seen = new Set<string>()
  const visit = (list: SurfaceCollection): SurfaceCollection | null => {
    if (hidden.has(list.id)) return null
    if (seen.has(list.id)) return list
    seen.add(list.id)
    const hiddenRows = new Set(decided.hidden_rows[list.id] ?? [])
    const kept = list.members.flatMap((member): SurfaceCollectionMember[] => {
      if (member.kind === 'surface') return hiddenRows.has(member.surfaceId) ? [] : [member]
      if (!member.childCollection) return [member]
      const child = visit(member.childCollection)
      return child ? [{ ...member, childCollection: child }] : []
    })
    if (!rulesOf(list.meta)) return { ...list, members: kept }
    const held = orderRows((decided.holds[list.id] ?? []).map((id) => byId.get(id) ?? { id }), list.meta.order_by as OrderBy | undefined)
      .map((row): SurfaceCollectionMember => ({ memberId: `surface:${String(row.id)}`, surfaceId: String(row.id), kind: 'surface', presentation: {} }))
    return { ...list, members: [...held, ...kept.filter((member) => member.kind !== 'surface')] }
  }
  return collections.map(visit).filter((list): list is SurfaceCollection => list !== null)
}
