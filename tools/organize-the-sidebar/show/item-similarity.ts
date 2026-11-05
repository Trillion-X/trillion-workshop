// packages/group/show/item-similarity.ts
//
// "Select similar" engine: from one anchor item, find every item that matches it
// by an INJECTED key extractor. The Figma/FigJam "Select all with same…" move, as
// a generative primitive (L069): the engine never names "kind" or "tag" — the board
// supplies the criterion as `keyOf`. Same-kind is `keyOf = i => i.kind`; same-tag is
// `keyOf = i => itemTags(i)`; a future criterion (fill, size) is one more call-site
// `keyOf` with ZERO engine change. Pure (no graph/React/I/O).

import type { BoardItem } from '../read-data/group-board-model.ts';

/** Normalize a keyOf result (one key or many) to a flat string[] (empties dropped). */
function toKeys(k: string | readonly string[]): string[] {
  if (Array.isArray(k)) return k.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return typeof k === 'string' && k.length > 0 ? [k] : [];
}

/**
 * The member ids of every item whose key-set INTERSECTS the anchor's key-set, per
 * `keyOf`. The anchor itself is always included (it matches itself). An anchor with
 * no keys → just `[anchorId]` (nothing to match on). A missing anchor → `[]`.
 * `keyOf` is the criterion: `i => i.kind` (one key) or `i => itemTags(i)` (many).
 */
export function similarIds(
  items: ReadonlyArray<BoardItem>,
  anchorId: string,
  keyOf: (item: BoardItem) => string | readonly string[],
): string[] {
  const anchor = items.find((i) => i.memberId === anchorId);
  if (!anchor) return [];
  const want = new Set(toKeys(keyOf(anchor)));
  if (want.size === 0) return [anchorId];
  return items.filter((i) => toKeys(keyOf(i)).some((k) => want.has(k))).map((i) => i.memberId);
}
