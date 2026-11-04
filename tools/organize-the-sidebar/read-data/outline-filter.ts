// packages/group/read-data/outline-filter.ts
//
// Filter/search for a long outline — the Workflowy/Notion "type to narrow" move. A pure view
// reducer over the flat `ListItem[]`: it never mutates the outline, it only decides which rows are
// SHOWN. A row is shown when its text matches the query OR it is an ANCESTOR of a match (so a
// matched child keeps its parent chain for context — a bare match with no path would be
// unreadable). Empty query → identity (every row), so the editor is byte-identical when not
// searching. Order-stable, deterministic, engine-free — composes with the fold reducer
// (`outline-fold`) the same way: the editor picks one reducer per render.

import type { ListItem } from './list-block-model';

const norm = (s: string): string => s.trim().toLowerCase();

/** The set of row ids whose text contains `query` (case-insensitive). Empty query → empty set. */
export function matchingRows(items: readonly ListItem[], query: string): ReadonlySet<string> {
  const q = norm(query);
  const out = new Set<string>();
  if (!q) return out;
  for (const it of items) if (it.text.toLowerCase().includes(q)) out.add(it.id);
  return out;
}

/**
 * The rows to SHOW under a text filter: every matching row PLUS its ancestor chain. Empty query →
 * all rows (identity). No match → `[]` (an honest empty result). Ancestors are found with a single
 * indent-stack pass (the same shape `outline-fold` uses): when a match is reached, every row
 * currently on the ancestor stack (strictly-shallower rows on the path to it) is kept for context.
 * Pure; original order preserved.
 */
export function visibleUnderFilter(items: readonly ListItem[], query: string): ListItem[] {
  const q = norm(query);
  if (!q) return items.slice();
  const matches = matchingRows(items, query);
  if (matches.size === 0) return [];
  const keep = new Set<string>(matches);
  const ancestors: ListItem[] = []; // the current path (rows of strictly-decreasing… ascending indent)
  for (const it of items) {
    while (ancestors.length && ancestors[ancestors.length - 1].indent >= it.indent) ancestors.pop();
    if (matches.has(it.id)) for (const anc of ancestors) keep.add(anc.id);
    ancestors.push(it);
  }
  return items.filter((it) => keep.has(it.id));
}
