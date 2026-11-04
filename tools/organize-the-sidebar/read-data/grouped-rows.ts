// packages/group/read-data/grouped-rows.ts
//
// ONE generic declared-order grouping fold (L069): any list whose rows carry an
// optional group NAME folds into ordered groups — first-seen group order, within-group
// declared order, ungrouped rows collected under the empty-string key (rendered
// header-less, last by convention of arrival). The fold never enumerates group names
// (L090) — any DATA string is a group. Consumers: the InsightsMenu lens picker
// (lens.group) and the Custom-actions popover (action record `section` DATA); any
// future sectioned menu reuses this instead of re-folding.
//
// `namedGroupCount` is the shared header gate (L118): section headers earn their
// pixels only when MORE THAN ONE named group is present — a single-group or
// ungrouped list renders flat.

export interface RowGroup<T> {
  readonly group: string;
  readonly rows: T[];
}

/** Fold rows into their declared groups: first-seen group order, within-group declared
 *  order, `''` collects the ungrouped. Pure; never enumerates a group name. */
export function foldRowGroups<T>(rows: readonly T[], groupOf: (row: T) => string | undefined): Array<RowGroup<T>> {
  const order: string[] = [];
  const byGroup = new Map<string, T[]>();
  for (const row of rows) {
    const g = groupOf(row) ?? '';
    let bucket = byGroup.get(g);
    if (!bucket) { bucket = []; byGroup.set(g, bucket); order.push(g); }
    bucket.push(row);
  }
  return order.map((group) => ({ group, rows: byGroup.get(group)! }));
}

/** How many NAMED (non-empty) groups the fold carries — the L118 header gate:
 *  render section headers only when this is > 1. */
export function namedGroupCount(groups: ReadonlyArray<{ readonly group: string }>): number {
  return groups.filter((g) => g.group !== '').length;
}
