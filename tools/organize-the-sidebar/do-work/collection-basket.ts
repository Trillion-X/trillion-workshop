// packages/group/do-work/collection-basket.ts
//
// The COLLECTION BASKET — accumulate selections from MANY boards, then merge them into ONE
// collection (R5 product surface: "pull in from all these other boards and throw all these
// different things in here into one template together"). This is the accumulator sibling of
// board-clipboard's singleton: where the clipboard holds ONE bundle (copy → paste), the basket
// holds MANY per-board picks (add on board A, switch, add on board B, …) and merges them via the
// pure `mergeSelectionsToCollection` primitive. A module singleton, so the basket survives board
// switches within the session — exactly like the clipboard (the "across boards" requirement).
//
// GENERIC: speaks only CollectionPick DATA + the merge primitive. No "vision board" vocabulary,
// no I/O, no React state — the panel reads it on demand and bumps its own render on change.

import type { CollectionPick, CollectionSourceItem } from '../read-data/selection-to-template';
import { mergeSelectionsToCollection } from '../read-data/selection-to-template';
import type { BoardTemplate } from '../read-data/board-template-apply';
import { buildShareCapsule, type ShareCapsule } from '../read-data/share-capsule';

// The live basket — one entry per "add selection" action (a board may contribute more than once).
let BASKET: CollectionPick[] = [];

/** Append a board's selection to the basket. An empty selection is ignored (nothing to add). */
export function addBasketPick(pick: CollectionPick): void {
  if (pick.selectedIds.length === 0) return;
  BASKET = [...BASKET, pick];
}

/** Read the current basket (the picks, in add order). */
export function readBasket(): readonly CollectionPick[] {
  return BASKET;
}

/** Drop the pick at `index` (a mis-add). Out-of-range → no-op. */
export function removeBasketPick(index: number): void {
  if (index < 0 || index >= BASKET.length) return;
  BASKET = BASKET.filter((_, i) => i !== index);
}

/** Empty the basket (after a successful save, or an explicit clear). */
export function clearBasket(): void {
  BASKET = [];
}

/** How many selections have been added (each add = one pick). */
export function basketPickCount(): number {
  return BASKET.length;
}

/** Total selected items across all picks — the "N items" the basket will collect. */
export function basketItemCount(): number {
  return BASKET.reduce((n, p) => n + p.selectedIds.length, 0);
}

/** Distinct source boards contributing to the basket (by boardId; a pick with no boardId counts
 *  as its own anonymous source) — the "from M boards" summary. */
export function basketBoardCount(): number {
  const ids = new Set<string>();
  let anon = 0;
  for (const p of BASKET) {
    if (p.boardId) ids.add(p.boardId);
    else anon += 1;
  }
  return ids.size + anon;
}

/** Merge the whole basket into ONE collection template via the pure primitive. `sectionsByLabel`
 *  defaults ON so each source board becomes a titled provenance section (a user's mental model:
 *  "throw all these into one template together"). Does NOT clear the basket — the caller clears
 *  after a successful save. */
export function basketToCollection(
  name: string,
  id?: string,
  opts?: { gap?: number; sectionsByLabel?: boolean },
): BoardTemplate {
  return mergeSelectionsToCollection(BASKET, name, id, { sectionsByLabel: true, ...opts });
}

/** Share the WHOLE basket as ONE link — "share several of my boards all at once with the same
 *  link" (R12). Each pick becomes a board in a multi-board ShareCapsule, scoped to that pick's
 *  selection. Composes the basket accumulator with the capsule primitive (L069) — zero new
 *  share logic. Does NOT clear the basket (the caller decides). */
export function basketToShareCapsule(name: string): ShareCapsule {
  return buildShareCapsule(
    BASKET.map((pick, i) => ({
      boardId: pick.boardId ?? `pick-${i}`,
      title: pick.label ?? 'Board',
      items: pick.allItems,
      scope: { kind: 'selection', selectedIds: pick.selectedIds },
    })),
    name,
  );
}

/** Convenience: build a pick from a board's flat item list + its selection (the panel's shape). */
export function basketPickFromSelection(
  boardId: string,
  label: string,
  allItems: readonly CollectionSourceItem[],
  selectedIds: readonly string[],
): CollectionPick {
  return { boardId, label, allItems, selectedIds };
}
