// packages/ui/show/record-views/field-order.ts
//
// Purpose
//   The person's order of a surface's fields, as DATA: the ids they arranged,
//   kept, with every field that appeared since joining at the end and every
//   field that went away dropping out. Columns, the Sort, Group and Filter
//   menus all read this one order, so dragging a field in any of them moves it
//   in all of them.

/** `kept` filtered to ids that still exist, then every new id in its own order. */
export function orderIds(kept: readonly string[], every: readonly string[]): string[] {
  const present = new Set(every)
  const known = [...new Set(kept)].filter(id => present.has(id))
  const seen = new Set(known)
  return [...known, ...every.filter(id => !seen.has(id))]
}
