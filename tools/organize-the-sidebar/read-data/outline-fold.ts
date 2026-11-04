// packages/group/read-data/outline-fold.ts
//
// The PURE fold/unfold logic of an outliner: a collapsed parent hides its whole subtree. This
// leaf owns ONLY the structural questions — "does this row have children?" and "which rows are
// hidden because an ancestor is collapsed?" — over the flat indent array. No React, no DOM, no
// I/O; deterministic. The editor/renderer keeps the set of collapsed ids and asks this leaf what
// to draw, so fold behaves identically in the edit surface and any read render (SSOT).

import type { ListItem } from './list-block-model';

/** Does the row at `index` have at least one child (a following row one level deeper)? Only a
 *  parent can be collapsed, so this gates the fold affordance. */
export function hasChildren(items: readonly ListItem[], index: number): boolean {
  const here = items[index];
  const next = items[index + 1];
  return !!here && !!next && next.indent > here.indent;
}

/** The ids hidden because a STRICT ancestor is collapsed. A collapsed row itself stays visible
 *  (you see the folded parent); everything under it disappears until a row at its level or
 *  shallower. Nested collapses compose — a row is hidden if ANY ancestor is collapsed. */
export function hiddenByCollapse(
  items: readonly ListItem[],
  collapsed: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  const ancestors: { id: string; indent: number }[] = [];
  for (const row of items) {
    // Keep only STRICT ancestors of this row on the stack (shallower indent).
    while (ancestors.length && ancestors[ancestors.length - 1].indent >= row.indent) ancestors.pop();
    if (ancestors.some((a) => collapsed.has(a.id))) hidden.add(row.id);
    ancestors.push({ id: row.id, indent: row.indent });
  }
  return hidden;
}

/** The rows to actually render: the full list minus everything hidden under a collapsed parent. */
export function visibleRows(
  items: readonly ListItem[],
  collapsed: ReadonlySet<string>,
): ListItem[] {
  if (collapsed.size === 0) return items.slice();
  const hidden = hiddenByCollapse(items, collapsed);
  return items.filter((it) => !hidden.has(it.id));
}
