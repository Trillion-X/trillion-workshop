// tools/turn-frames-into-slides/read-data/board-frames.ts
//
// =============================================================================
// PURPOSE — Presentable Frames / Story Path (board attention-routing)
// =============================================================================
//
// The pure model for durable, named board FRAMES: rectangular world regions with
// an ordered presentation path. On a large board the limiting problem is not
// editing objects, it is ATTENTION ROUTING — Figma/Miro/Mural power users turn
// infinite canvas into named chapters (navigate, present, export, return). A frame
// is the persistent configuration of the existing `frameCamera` primitive (L069):
// `frameCamera` already computes the camera that fits a rect; a frame just PERSISTS
// a rect + an order to walk with it.
//
// ZERO new engine mechanism (L090): a frame is a normal board member with
// `kind:'frame'` + opaque `extra.presentationFrame = { order }`. `placeItem` writes
// any kind/geometry/extra verbatim; `readItems` preserves them; so a frame drags,
// resizes, locks, z-orders, exports, and appears in the Objects panel FOR FREE
// (it is just an item). This leaf owns only the pure derivations; the renderer draws
// the frame chrome from its `kind` (no per-frame chrome DATA), and the panel walks
// `boardFrames` through `frameCamera` to present.
//
// SSOT: `presentationFrameOf` is the ONE frame predicate — partition by SHAPE
// (`extra.presentationFrame` with a numeric order), never a `kind === 'frame'`
// string literal — the same discipline as `itemIsConnector` / `itemIsLocked`.
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { GroupGraph, AddressRef } from './group-graph.ts';
import { readItems, placeItem, itemIsConnector, type BoardItem } from './group-board-model.ts';
import { selectionBounds, type Rect } from './group-resize.ts';
import { finiteCoord } from './finite-coord.ts';

/** `Math.max` over an array WITHOUT spreading it — `Math.max(...arr)` RangeErrors past the JS argument
 *  limit, so tidying a frame holding hundreds of thousands of items crashed. Reduce is O(n)-safe. */
function maxOf(values: Iterable<number>): number {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return m;
}

/** The presentation-frame facet a frame member carries, or null when the item is not
 *  a frame. Shape-based (L090): an object with a numeric `order`. This is the ONE
 *  canonical frame predicate — every frame reader (present controller, Objects label,
 *  export) asks THIS, never a `kind === 'frame'` literal. */
export interface PresentationFrame {
  /** Position in the ordered presentation path (asc). Frames with equal order keep
   *  their relative array order (stable sort) so the walk is deterministic. */
  readonly order: number;
}

export function presentationFrameOf(item: BoardItem): PresentationFrame | null {
  const pf = item.extra?.presentationFrame;
  if (pf && typeof pf === 'object' && typeof (pf as { order?: unknown }).order === 'number') {
    // Normalize the order to a FINITE number at the source (SSOT). A NaN/Infinity order (malformed
    // DATA / a hostile capsule) would make the boardFrames sort comparator return NaN — a non-
    // transitive comparison that misorders even the well-formed frames, and would slip past
    // nextFrameOrder's `> max`. A malformed order defaults to 0 (deterministic, index-tiebroken).
    const raw = (pf as { order: number }).order;
    return { order: Number.isFinite(raw) ? raw : 0 };
  }
  return null;
}

/** Every frame on the board, in presentation order (`order` asc, stable). The story path. */
export function boardFrames(items: readonly BoardItem[]): BoardItem[] {
  return items
    .map((item, index) => ({ item, index, pf: presentationFrameOf(item) }))
    .filter((e): e is { item: BoardItem; index: number; pf: PresentationFrame } => e.pf !== null)
    .sort((a, b) => a.pf.order - b.pf.order || a.index - b.index)
    .map((e) => e.item);
}

/** The order to assign the NEXT frame so it lands at the end of the path: `max(order)+1`,
 *  or 0 when there are no frames yet. */
export function nextFrameOrder(items: readonly BoardItem[]): number {
  let max = -Infinity;
  for (const item of items) {
    const pf = presentationFrameOf(item);
    if (pf && pf.order > max) max = pf.order;
  }
  return max === -Infinity ? 0 : max + 1;
}

/** The world rect a frame occupies (its own geometry) — the camera target to present it. */
export function frameRect(item: BoardItem): Rect {
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}

/**
 * The frame's spatial CONTENTS: every non-frame, non-connector item whose CENTRE lies
 * within `frame`'s rect (FigJam "section" membership by geometry — a frame is a soft
 * container, not an owner, so membership is derived, never stored). Centre-inside (not
 * fully-inside) so a slightly-overhanging sticky still counts as "in the frame". Pure —
 * the surface uses it to select-everything-in-a-frame with zero new selection mechanism.
 */
export function itemsInsideFrame(items: readonly BoardItem[], frame: BoardItem): BoardItem[] {
  const x0 = frame.x;
  const y0 = frame.y;
  const x1 = frame.x + frame.w;
  const y1 = frame.y + frame.h;
  return items.filter((i) => {
    if (i.memberId === frame.memberId) return false;
    if (itemIsConnector(i) || presentationFrameOf(i) !== null) return false;
    const cx = i.x + i.w / 2;
    const cy = i.y + i.h / 2;
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  });
}

/**
 * Widen a moving set so that dragging a presentation frame CARRIES its spatial
 * contents (FigJam "section-move"). For every base id that is a presentation
 * frame, unions in the memberIds of `itemsInsideFrame(frame)`. Connectors are
 * excluded (they auto-follow their moved endpoints, so translating them too
 * would double-move) and nesting is single-level (matches `itemsInsideFrame`'s
 * contract). PURE: the surface widens the drag set and the existing shared-delta
 * translate + snap + commit carry the contents with ZERO new move code. A base
 * id that is not a frame passes through unchanged, so a plain multi-drag is a
 * no-op here.
 */
export function withFrameContents(items: readonly BoardItem[], baseIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(baseIds);
  for (const m of items) {
    if (baseIds.has(m.memberId) && presentationFrameOf(m) !== null) {
      for (const child of itemsInsideFrame(items, m)) out.add(child.memberId);
    }
  }
  return out;
}

/**
 * A presentation frame's CAPTION / speaker-note (#176) — free text shown below the
 * present bar while walking the story path. Stored as a SEPARATE `extra.frameCaption`
 * key (not nested in `presentationFrame`) so writing it never disturbs the frame's
 * `order`. Returns the trimmed non-empty string, or `null` when absent/blank. Pure,
 * shape-based (L090) — the surface reads it per current frame; the canvas is blind.
 */
export function presentationCaptionOf(item: BoardItem): string | null {
  const c = item.extra?.frameCaption;
  if (typeof c !== 'string') return null;
  const t = c.trim();
  return t.length > 0 ? t : null;
}

/**
 * The present-path index a frame ADVANCES to when it has an outgoing frame→frame
 * connector (#175 — prototype links EMERGE from the existing #98 connector, zero
 * new link DATA or create-UI). Scans `items` for a connector whose `from` is the
 * current frame and whose `to` is ANOTHER frame in `orderedFrames`; returns that
 * frame's index, or `null` when the current frame has no such link (advance falls
 * back to the sequential next). The FIRST matching connector wins. PURE — present
 * mode reads this on advance; the canvas is never mutated.
 */
export function frameLinkTarget(
  orderedFrames: readonly BoardItem[],
  items: readonly BoardItem[],
  currentIndex: number,
): number | null {
  const cur = orderedFrames[currentIndex];
  if (!cur) return null;
  const frameIndex = new Map(orderedFrames.map((f, i) => [f.memberId, i]));
  for (const it of items) {
    if (!itemIsConnector(it)) continue;
    const from = it.extra?.fromMemberId;
    const to = it.extra?.toMemberId;
    if (from === cur.memberId && typeof to === 'string' && frameIndex.has(to)) {
      return frameIndex.get(to)!;
    }
  }
  return null;
}

/** A frame's new present-order after a reorder (surface commits via `patchItem`). */
export interface FrameOrderPatch {
  readonly id: string;
  readonly order: number;
}

/**
 * Move one frame EARLIER (`dir = -1`) or LATER (`dir = +1`) in the present path
 * and return the CONTIGUOUS renumbering of every frame (0..n-1). Frames are
 * sorted by their current `presentationFrame.order`; the target swaps places with
 * its neighbour in `dir`, then all frames are renumbered to their new array index
 * (so orders stay dense even if they started sparse). Returns `[]` when the target
 * is missing or already at the boundary (a no-op — the surface skips the commit).
 * PURE — the surface writes each `{id, order}` back via `patchItem`.
 */
export function moveFrameOrder(
  frames: readonly BoardItem[],
  frameId: string,
  dir: -1 | 1,
): FrameOrderPatch[] {
  const sorted = [...frames].sort((a, b) => (presentationFrameOf(a)?.order ?? 0) - (presentationFrameOf(b)?.order ?? 0));
  const idx = sorted.findIndex((f) => f.memberId === frameId);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= sorted.length) return [];
  const ids = sorted.map((f) => f.memberId);
  [ids[idx], ids[j]] = [ids[j], ids[idx]];
  return ids.map((id, i) => ({ id, order: i }));
}

/** A new top-left for one item after a tidy pass (surface commits these via `moveItem`). */
export interface FrameTidyPos {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Arrange a frame's CONTENTS into an even grid inside the frame (FigJam
 * "reorganize section"). Takes the already-resolved contents (caller filters
 * locked items + reads `itemsInsideFrame`), orders them top-to-bottom then
 * left-to-right (stable — preserves rough arrangement), and lays them on a
 * uniform grid (cell = max content w/h + gap) that fits the frame width below
 * its title band. Each item is CENTRED in its cell so varied sizes align. PURE —
 * returns new positions; the surface commits them through its existing move path.
 */
export function tidyFrameLayout(
  contents: readonly BoardItem[],
  frame: BoardItem,
  opts: { pad?: number; gap?: number; titleInset?: number } = {},
): FrameTidyPos[] {
  if (contents.length === 0) return [];
  const pad = opts.pad ?? 24;
  const gap = opts.gap ?? 20;
  const titleInset = opts.titleInset ?? 44;
  const ordered = contents.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const cellW = maxOf(ordered.map((i) => finiteCoord(i.w))); // reduce (not spread) + finiteCoord: wide frame + MAX_VALUE safe
  const cellH = maxOf(ordered.map((i) => finiteCoord(i.h)));
  const usableW = frame.w - pad * 2;
  const cols = Math.max(1, Math.min(ordered.length, Math.floor((usableW + gap) / (cellW + gap)) || 1));
  const originX = frame.x + pad;
  const originY = frame.y + titleInset;
  return ordered.map((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = originX + col * (cellW + gap);
    const cellY = originY + row * (cellH + gap);
    return { id: item.memberId, x: Math.round(cellX + (cellW - item.w) / 2), y: Math.round(cellY + (cellH - item.h) / 2) };
  });
}

/** Clamp a frame index into `[0, count-1]` (or 0 when there are no frames). */
export function clampFrameIndex(count: number, index: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}

/** The next index when stepping the presentation by `dir` (<0 = previous, ≥0 = next),
 *  clamped — no wrap: a story path has a first and a last frame, and Next on the last
 *  (or Prev on the first) stays put rather than looping. */
export function presentStep(count: number, index: number, dir: number): number {
  return clampFrameIndex(count, index + (dir < 0 ? -1 : 1));
}

/**
 * Create a frame that bounds the current selection (Figma/Miro "frame selection"). Unions the
 * selected NON-connector item rects, expands by `padding`, and `placeItem`s a `kind:'frame'`
 * member carrying `extra.presentationFrame.order`. Pure graph→graph; all ids + the title/order
 * are INJECTED (the panel supplies fresh ids + `nextFrameOrder`, the test supplies fixed ones).
 * Returns the graph UNCHANGED when the selection has no non-connector items (nothing to bound).
 */
export function createFrameFromSelection(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  opts: { memberId: string; nodeRef: AddressRef; title: string; padding: number; order: number },
): GroupGraph {
  const wanted = new Set(memberIds);
  const rects: Rect[] = readItems(graph, parentRef)
    .filter((i) => wanted.has(i.memberId) && !itemIsConnector(i))
    .map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
  const bounds = selectionBounds(rects);
  if (!bounds) return graph;
  return placeItem(graph, parentRef, {
    memberId: opts.memberId,
    nodeRef: opts.nodeRef,
    kind: 'frame',
    x: bounds.x - opts.padding,
    y: bounds.y - opts.padding,
    w: bounds.w + opts.padding * 2,
    h: bounds.h + opts.padding * 2,
    text: opts.title,
    extra: { presentationFrame: { order: opts.order } },
  });
}

/**
 * Reshape a frame's box to a target aspect ratio (#177 — "make this frame a slide").
 * PRESERVES the frame's top-left AND its current WIDTH; only the HEIGHT conforms to the
 * ratio (the FigJam/Figma frame-preset behaviour — the frame stays where it is and as
 * wide as it is, and becomes a 16:9 / 4:3 / 1:1 / A4 canvas). Returns the new `{w,h}`;
 * x/y are the caller's and never move. Pure — the ratio is DATA (`FRAME_ASPECTS`), so a
 * new preset is one catalog row and this math never changes (L090).
 *
 * A non-positive ratio or width → the box is returned unchanged (fail-closed, never a
 * zero/NaN geometry). Height floors at 1px so a frame is always a visible region.
 */
export function resizeToAspect(
  box: { readonly w: number; readonly h: number },
  ratioW: number,
  ratioH: number,
): { w: number; h: number } {
  if (!(ratioW > 0) || !(ratioH > 0) || !(box.w > 0)) return { w: box.w, h: box.h };
  return { w: box.w, h: Math.max(1, Math.round((box.w * ratioH) / ratioW)) };
}

/**
 * The box a frame should take to snugly bound its CURRENT spatial contents (#178 —
 * FigJam/Figma "resize section to fit"). Unions the rects of `itemsInsideFrame`, expands
 * by `padding`, and returns the new frame rect (the top-left may move outward to hug the
 * contents). Returns `null` when the frame is empty — nothing to bound, so the caller
 * no-ops. Pure — reuses the SAME `selectionBounds` union as `createFrameFromSelection`,
 * so "fit" and "frame the selection" agree on geometry exactly (one bounds primitive).
 */
export function frameFitBox(items: readonly BoardItem[], frame: BoardItem, padding: number): Rect | null {
  const rects: Rect[] = itemsInsideFrame(items, frame).map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
  const bounds = selectionBounds(rects);
  if (!bounds) return null;
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    w: bounds.w + padding * 2,
    h: bounds.h + padding * 2,
  };
}
