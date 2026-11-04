// packages/group/read-data/box-select.ts
//
// SPATIAL box-select — the cards inside a rectangle, the geometric sibling of `reportSelect` (b180, cards in
// the report groups a predicate keeps). Marquee/drag-select is core to every canvas, but the hit-test lived
// inline in the panel; this extracts it as a pure, testable leaf so the same "which cards does this rectangle
// grab" logic powers marquee, select-in-viewport, and select-in-region for the reducer family.
//
// Two modes, the design-tool canon (Figma/Illustrator): INTERSECT ("crossing" — any overlap selects, the fast
// grab) and CONTAIN ("window" — only fully-enclosed cards select, the precise grab). The mode is DATA, not a
// branch the caller re-implements. Screen projection is the board's canon (screen = world*zoom + pan), so a
// drag rectangle in screen space converts to a world box via `worldRectFromScreen`. Pure, deterministic; owns
// no board vocabulary (cards enter as their world boxes).

import type { BoardItem } from './group-board-model';
import type { Camera, Viewport, WorldBox } from './viewport-visibility';

/** How a card qualifies for a marquee: any overlap (`intersect`) or fully enclosed (`contain`). */
export type SelectMode = 'intersect' | 'contain';

/** True iff the two world boxes overlap at all (touching edges do NOT count). */
function boxesOverlap(a: WorldBox, b: WorldBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** True iff `inner` is fully within `outer` (edges may touch). */
function boxContains(outer: WorldBox, inner: WorldBox): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** A card's world box. */
function boxOf(i: BoardItem): WorldBox {
  return { x: i.x, y: i.y, w: i.w, h: i.h };
}

/**
 * The ids of the items a world `rect` selects under `mode` — `intersect` (any overlap) or `contain` (fully
 * enclosed). Purely geometric over whatever items are passed (the caller decides whether to exclude connectors
 * / furniture). Deterministic (input order). Empty rect or no hits → []. Pure.
 */
export function itemsInRect(items: readonly BoardItem[], rect: WorldBox, mode: SelectMode = 'intersect'): string[] {
  const out: string[] = [];
  for (const i of items) {
    const b = boxOf(i);
    if (mode === 'contain' ? boxContains(rect, b) : boxesOverlap(rect, b)) out.push(i.memberId);
  }
  return out;
}

/** Convert a SCREEN-space rectangle (a drag box) to a world box under `cam`, inverting the board's projection
 *  (`world = (screen - pan) / zoom`). Negative width/height (dragging up/left) are normalised to a positive
 *  box, so a marquee works in any drag direction. */
export function worldRectFromScreen(screen: { x: number; y: number; w: number; h: number }, cam: Camera): WorldBox {
  const x1 = (screen.x - cam.panX) / cam.zoom;
  const y1 = (screen.y - cam.panY) / cam.zoom;
  const x2 = (screen.x + screen.w - cam.panX) / cam.zoom;
  const y2 = (screen.y + screen.h - cam.panY) / cam.zoom;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** The ids of every item currently on-screen (composes `worldRectFromScreen` over the whole viewport) — the
 *  "select all visible" operation. `intersect` grabs partially-visible cards; `contain` only fully-visible. */
export function itemsInViewport(items: readonly BoardItem[], cam: Camera, view: Viewport, mode: SelectMode = 'intersect'): string[] {
  return itemsInRect(items, worldRectFromScreen({ x: 0, y: 0, w: view.w, h: view.h }, cam), mode);
}

/** The complement of a selection over a set of items — the ids NOT selected (invert-selection). Input order. */
export function invertSelection(items: readonly BoardItem[], selectedIds: readonly string[]): string[] {
  const sel = new Set(selectedIds);
  return items.filter((i) => !sel.has(i.memberId)).map((i) => i.memberId);
}
