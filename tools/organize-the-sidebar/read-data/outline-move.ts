// packages/group/read-data/outline-move.ts
//
// Subtree-aware MOVE for outline rows — the missing reorder primitive. `moveItem` (list-block-
// model) swaps a row with its single neighbour, which CORRUPTS the tree when the row is a parent:
// moving a parent "down" swaps it with its own first child, and normalizeIndents then promotes the
// orphaned child. The correct unit of movement is the SUBTREE (the row + all its descendants),
// moved as one block. This leaf owns that:
//   • subtreeRange  — the [start, end) block of a row + its descendants (indent-contiguous)
//   • moveSubtree   — move that block to before any target row (or to the end) — the drag-drop core
//   • moveSubtreeDir— sibling-aware up/down (moves the whole block past the adjacent SIBLING block)
// Every op re-runs the pure `normalizeIndents` so the result is always a well-formed outline.
// Pure, deterministic, engine-free — one primitive, three emergent motions (up, down, drag-to-drop).

import { normalizeIndents, type ListItem } from './list-block-model';

const indexOfId = (items: readonly ListItem[], id: string): number =>
  items.findIndex((it) => it.id === id);

/** The half-open index range `[start, end)` of the row at `index` PLUS all its descendants —
 *  the contiguous run of following rows whose indent is deeper than the row's own. A leaf row
 *  yields `[index, index+1)`. Out-of-range index → an empty range at that index. */
export function subtreeRange(items: readonly ListItem[], index: number): [number, number] {
  if (index < 0 || index >= items.length) return [index, index];
  const base = items[index].indent;
  let end = index + 1;
  while (end < items.length && items[end].indent > base) end += 1;
  return [index, end];
}

/**
 * Move the subtree rooted at `id` so its first row lands immediately BEFORE the row `beforeId`
 * (or at the END when `beforeId` is null / not found). The whole block travels together, so a
 * parent keeps its children. No-op if `beforeId` is a row INSIDE the moved block (a subtree can't
 * be dropped into itself). Re-normalizes indents so the block adopts a legal depth at its new
 * home (relative nesting preserved). Pure.
 */
export function moveSubtree(
  items: readonly ListItem[],
  id: string,
  beforeId: string | null,
): ListItem[] {
  const index = indexOfId(items, id);
  if (index < 0) return items.slice();
  const [start, end] = subtreeRange(items, index);
  const block = items.slice(start, end);
  if (beforeId != null && block.some((b) => b.id === beforeId)) return items.slice(); // into itself
  const rest = [...items.slice(0, start), ...items.slice(end)];
  let insertAt = rest.length;
  if (beforeId != null) {
    const bi = rest.findIndex((it) => it.id === beforeId);
    if (bi >= 0) insertAt = bi;
  }
  return normalizeIndents([...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)]);
}

/**
 * Move the subtree rooted at `id` UP or DOWN among its SIBLINGS — the whole block hops past the
 * adjacent sibling's whole block (never swapping a parent with its own child, the `moveItem` bug).
 * A no-op when there is no sibling in that direction (the block is the first/last child at its
 * level). Pure.
 */
export function moveSubtreeDir(
  items: readonly ListItem[],
  id: string,
  dir: 'up' | 'down',
): ListItem[] {
  const index = indexOfId(items, id);
  if (index < 0) return items.slice();
  const [start, end] = subtreeRange(items, index);
  const baseIndent = items[start].indent;

  if (dir === 'down') {
    // The next row after the block, if it is a SIBLING (same indent), starts the next sibling's
    // subtree; move THIS block to just after that sibling's whole subtree.
    if (end >= items.length || items[end].indent !== baseIndent) return items.slice();
    const [, siblingEnd] = subtreeRange(items, end);
    const beforeId = siblingEnd < items.length ? items[siblingEnd].id : null;
    return moveSubtree(items, id, beforeId);
  }

  // UP: scan back from the row before the block. Skip the previous sibling's descendants; the
  // first row at our own indent is the previous sibling's root — move before it. A shallower row
  // first means we are the first child → no previous sibling.
  for (let j = start - 1; j >= 0; j -= 1) {
    if (items[j].indent < baseIndent) break;
    if (items[j].indent === baseIndent) return moveSubtree(items, id, items[j].id);
  }
  return items.slice();
}
