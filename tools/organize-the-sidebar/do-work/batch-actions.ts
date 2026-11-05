// packages/group/do-work/batch-actions.ts
//
// =============================================================================
// PURPOSE — P2: the board's BatchActionCapability pack (multi-edit over a SET)
// =============================================================================
//
// Every "do this to ALL selected items at once" the board offers — align,
// distribute, equal-size, apply-a-layer-stack-to-all, copy-the-stack, save/apply
// a preset, duplicate, delete, group — is ONE owner-provided BatchActionCapability
// (ui/show/node-actions/batch-action-types). The generic bulk-select bar renders
// whichever accept the current set; the surface supplies the pack.
//
// SHAPE: the GEOMETRY/transform math here is PURE — each helper takes a graph +
// parentRef + the selected memberIds and returns a NEW graph, folding the ONE
// generic item mutation (`patchItem`). The board wraps a chosen helper in `apply`
// which snapshots → commits ONE write-batch → records ONE undo checkpoint. So a
// 12-item align is one engine write and one Cmd-Z, never 12 of each.
//
// NodeRef ↔ memberId is the translation boundary (L098): the generic capability
// speaks NodeRef; the board reads `ref.parts.member` at its edge. Adding a new
// multi-edit = adding one entry to `buildBoardBatchPack`, ZERO dispatch code.
// =============================================================================

import type { BatchActionCapability, BatchRunContext, NodeRef, NodeActionCapability } from '../../ui/show/node-actions';
import type { VisualLayerStackRecord } from '../../ui/show/visual-layer-stack/visual-layer-types';
import type { GroupGraph, AddressRef } from '../../ui/show/group/group-graph';
import { reorderMember } from '../../ui/show/group/group-graph';
import { readItems, patchItem, patchItems, setMemberOrder, itemIsConnector, itemIsLocked, placeItem, removeItem, itemRef, assignGroupId, groupIdOf, releaseGroupId } from '../read-data/group-board-model.ts';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { presentationFrameOf, resizeToAspect, toggleFrameFold } from './board-frames.ts';
/** A folded frame's height: room for its name alone. */
const FOLDED_FRAME_HEIGHT = 56;
import { circleLayoutRadius } from './circle-layout.ts';
import { arrangeByField, arrangeByFieldWithRegions, arrangeColumns, regionHeadingSpecs, regionLabelFor } from '../show/arrange-by-field.ts';
import type { ArrangeItem, ArrangeByFieldOptions, ClusterLayout } from '../show/arrange-by-field.ts';
import { arrangeMatrix } from '../show/arrange-matrix.ts';
import { axisPlot, axisTicks, axisTickLabels, arrangeTimelineLanes } from '../show/arrange-by-axis.ts';
import { dueDateOfItem } from './board-due-date-actions.ts';
import { dueMsToDateLabel, dueDateFromRaw } from '../read-data/board-due-date.ts';
import { voteCount, tallyFromRaw } from '../read-data/board-votes.ts';
import { checklistFromRaw, checklistProgress } from '../read-data/board-checklist.ts';
import { cardCompletion } from '../read-data/card-completion.ts';
export { cardCompletion } from '../read-data/card-completion.ts';
import { importanceRanks, importanceValue } from '../read-data/board-importance.ts';
import { numberedCommunities } from '../read-data/board-communities.ts';
import type { AxisItem, ArrangeByAxisOptions } from '../show/arrange-by-axis.ts';
import { resolveOverlaps } from '../show/resolve-overlaps.ts';
import {
  tidyTreeLayout,
  GRAPH_LAYOUTS,
  type GraphNode,
  type GraphEdge,
  type GraphLayoutStrategy,
  type GraphLayoutOptions,
} from '../show/graph-layout.ts';
import { buildRelationGraph } from '../read-data/relationship-graph.ts';
import { finiteCoord } from '../read-data/finite-coord.ts';
import { itemTags } from '../show/item-tags.ts';
import { itemFillColor, hueOf, setStackFill, emptyStack, BOARD_ITEM_LAYER_REGISTRY } from '../show/item-fill.ts';
import { BOARD_PALETTES, cycleAssign, recolorToPalette, fixedColorAssign } from '../show/board-palettes.ts';
import type { BoardPalette, PaletteAssign } from '../show/board-palettes.ts';
import { BOARD_ITEM_FACETS } from '../show/board-item-facets.ts';
import { facetColorAssignment } from '../read-data/facet-filter.ts';
import type { FacetExtractor } from '../read-data/facet-filter.ts';
import { BOARD_HARMONY_SCHEMES, harmonize } from '../show/color-harmony.ts';
import type { HarmonyScheme } from '../show/color-harmony.ts';
import { MARKER_FACET_LABELS } from '../show/board-marker-catalog.ts';
import { SHAPE_FACET_LABELS } from '../show/board-shapes.ts';
import { finiteCoord } from '../read-data/finite-coord.ts';

// Reduce-based bounds over the SELECTED items — NEVER `minOf(items.map(...))`: a large untrusted
// selection (select-all on an imported/hostile board) RangeErrors past the JS spread argument limit
// (~65k-125k). `finiteCoord` each element so a NaN/MAX_VALUE coord can't poison a persisted origin/span
// (and the batch layout math that follows). Empty → 0 (a no-op layout; every caller guards emptiness).
export const minOf = (xs: readonly number[]): number => (xs.length ? xs.reduce((m, v) => Math.min(m, finiteCoord(v)), Infinity) : 0);
export const maxOf = (xs: readonly number[]): number => (xs.length ? xs.reduce((m, v) => Math.max(m, finiteCoord(v)), -Infinity) : 0);

/** The board's node family — the one place its NodeRef family string lives. */
export const BOARD_ITEM_FAMILY = 'group.board-item';

/** memberId of every selected board-item NodeRef (ignores foreign families). */
export function membersOfRefs(refs: readonly NodeRef[]): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    const m = ref.parts?.member;
    if (typeof m === 'string' && m) ids.push(m);
  }
  return ids;
}

export interface Box {
  readonly memberId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The item's text — carried so an injected `arrangeBy` ORDER comparator can sort by content
   *  (e.g. alphabetical). Absent → ''. Positioning never reads it; only the optional order does. */
  readonly text?: string;
  /** The item's fill colour — carried so an ORDER comparator can sort by colour (hue/rainbow).
   *  Absent → undefined. Positioning never reads it; only the optional order does. */
  readonly fill?: string;
  /** The item's UNIFIED completion 0..1 — metric progress if it has a metric, else checklist
   *  fraction, else undefined (no progress). Pre-derived like `fill`, so an ORDER comparator can
   *  rank "how done is this card" without re-parsing. Positioning never reads it. */
  readonly progress?: number;
  /** The item's due date (epoch-ms) if it carries one, else undefined — carried so an ORDER
   *  comparator can sort chronologically. Positioning never reads it; only the optional order does. */
  readonly due?: number;
}


/** The positioned boxes for the selected members, in selection order, current group only.
 *  Every coordinate is sanitized through {@link finiteCoord} — this is the ONE entry into
 *  align/distribute/arrange/snap, so a single persisted/producer-written NON-FINITE or
 *  FINITE-HUGE (overflow-to-Infinity) coordinate can no longer poison the min/max/span of a
 *  whole batch op (L063 category fix: one filter here, every geometry op fails closed). A
 *  no-op for real boxes. */
function boxesFor(graph: GroupGraph, parentRef: AddressRef, memberIds: readonly string[]): Box[] {
  const want = new Set(memberIds);
  return readItems(graph, parentRef)
    .filter((i) => want.has(i.memberId))
    .map((i) => ({
      memberId: i.memberId,
      x: finiteCoord(i.x),
      y: finiteCoord(i.y),
      w: finiteCoord(i.w),
      h: finiteCoord(i.h),
      text: typeof i.text === 'string' ? i.text : '',
      fill: itemFillColor(i),
      progress: cardCompletion(i),
      due: dueDateFromRaw(i.extra?.dueDate) ?? undefined,
    }));
}

/**
 * `readItems` with EVERY coordinate sanitized through {@link finiteCoord} — the SSOT companion to
 * {@link boxesFor} for the arrange-BY-* / axis / matrix / graph layouts, which need per-item fields
 * beyond a {@link Box} (groupKey, valueX, edges) and so cannot use `boxesFor`. Those layouts read raw
 * `i.x/i.y/i.w/i.h` into span/scale/anchor math where a persisted FINITE-HUGE value (`Number.MAX_VALUE`
 * IS valid JSON, so it passes `readItems`) overflows to `Infinity` — poisoning the min/max/span of the
 * whole cluster and NaN-ing every placed position. Sanitizing at this ONE read fails such a value closed
 * to the board limit (L063 category fix); a no-op for real items (finiteCoord returns them unchanged).
 */
function readFiniteItems(graph: GroupGraph, parentRef: AddressRef): BoardItem[] {
  return readItems(graph, parentRef).map((i) => ({
    ...i,
    x: finiteCoord(i.x),
    y: finiteCoord(i.y),
    w: finiteCoord(i.w),
    h: finiteCoord(i.h),
  }));
}

/**
 * The subset of `memberIds` that are NOT locked. A locked item (`extra.locked ===
 * true`) is FULLY FROZEN — position, size, rotation, layer order, and appearance —
 * exactly like pointer drag/resize and keyboard nudge/delete already enforce. Every
 * IN-PLACE batch mutation (the geometry/z-order ops via `geom()`, paste-style, fill)
 * runs through this single chokepoint so a locked item can never be mutated by a
 * batch op. This is the L063 category fix: one filter, every op lock-safe, and any
 * FUTURE batch mutation that routes through it is automatically lock-safe too.
 */
export function unlockedOf(graph: GroupGraph, memberIds: readonly string[], parentRef: AddressRef): string[] {
  const locked = new Set(
    readItems(graph, parentRef)
      .filter((i) => itemIsLocked(i))
      .map((i) => i.memberId),
  );
  return memberIds.filter((id) => !locked.has(id));
}

/** Fold a per-member geometry patch over the graph. Delegates to the O(M+K) batch primitive
 *  `patchItems` (ONE members-map spread for the whole batch) — the naive fold of `patchItem` was
 *  O(K*M) = O(N^2) on a select-all, freezing the commit path on a large board. Semantically identical
 *  for every live member; a stale id is skipped rather than aborting the batch. */
function patchEach(
  graph: GroupGraph,
  parentRef: AddressRef,
  patches: ReadonlyArray<{ memberId: string; patch: Record<string, unknown> }>,
): GroupGraph {
  return patchItems(graph, parentRef, patches);
}

// ── ALIGN — snap every box's edge/center to the selection's bounding extent. ──

type AlignAxis = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function alignBoxes(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  axis: AlignAxis,
): GroupGraph {
  const boxes = boxesFor(graph, parentRef, memberIds);
  if (boxes.length < 2) return graph;
  const minX = minOf(boxes.map((b) => b.x));
  const maxR = maxOf(boxes.map((b) => b.x + b.w));
  const minY = minOf(boxes.map((b) => b.y));
  const maxB = maxOf(boxes.map((b) => b.y + b.h));
  const midX = (minX + maxR) / 2;
  const midY = (minY + maxB) / 2;
  const patches = boxes.map((b) => {
    switch (axis) {
      case 'left': return { memberId: b.memberId, patch: { x: Math.round(minX) } };
      case 'right': return { memberId: b.memberId, patch: { x: Math.round(maxR - b.w) } };
      case 'hcenter': return { memberId: b.memberId, patch: { x: Math.round(midX - b.w / 2) } };
      case 'top': return { memberId: b.memberId, patch: { y: Math.round(minY) } };
      case 'bottom': return { memberId: b.memberId, patch: { y: Math.round(maxB - b.h) } };
      case 'vcenter': return { memberId: b.memberId, patch: { y: Math.round(midY - b.h / 2) } };
    }
  });
  return patchEach(graph, parentRef, patches);
}

// ── DISTRIBUTE — even the centers between the two outermost boxes (≥3). ──

export function distributeBoxes(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  axis: 'h' | 'v',
): GroupGraph {
  const boxes = boxesFor(graph, parentRef, memberIds);
  if (boxes.length < 3) return graph;
  const center = (b: Box) => (axis === 'h' ? b.x + b.w / 2 : b.y + b.h / 2);
  const sorted = [...boxes].sort((a, b) => center(a) - center(b));
  const first = center(sorted[0]);
  const last = center(sorted[sorted.length - 1]);
  const step = (last - first) / (sorted.length - 1);
  const patches = sorted.slice(1, -1).map((b, i) => {
    const targetCenter = first + step * (i + 1);
    return axis === 'h'
      ? { memberId: b.memberId, patch: { x: Math.round(targetCenter - b.w / 2) } }
      : { memberId: b.memberId, patch: { y: Math.round(targetCenter - b.h / 2) } };
  });
  return patchEach(graph, parentRef, patches);
}

/**
 * Distribute the selection so every consecutive EDGE-TO-EDGE GAP is equal — the
 * Figma "Tidy up" / FigJam "distribute spacing" move. Unlike {@link distributeBoxes}
 * (which evens CENTRES — correct only when all items are the same size), this evens
 * the visible whitespace BETWEEN items, which is what the eye reads on a mixed-size
 * board. The two extreme items (by leading edge) stay anchored; the inner items are
 * laid out edge-to-edge with a constant gap = (outer span − Σ sizes) / (n−1). A
 * negative gap (items overlap / exceed the span) is still applied evenly — no special
 * case. The L069 sibling of `distributeBoxes`: same bbox/sort/patchEach shape, ≥3 guard.
 */
export function distributeSpacing(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  axis: 'h' | 'v',
): GroupGraph {
  const boxes = boxesFor(graph, parentRef, memberIds);
  if (boxes.length < 3) return graph;
  const lead = (b: Box) => (axis === 'h' ? b.x : b.y);
  const size = (b: Box) => (axis === 'h' ? b.w : b.h);
  const sorted = [...boxes].sort((a, b) => lead(a) - lead(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = lead(last) + size(last) - lead(first); // outer extent (ends fixed)
  const totalSize = sorted.reduce((sum, b) => sum + size(b), 0);
  const gap = (span - totalSize) / (sorted.length - 1);
  let cursor = lead(first) + size(first);
  const patches = sorted.slice(1, -1).map((b) => {
    const at = cursor + gap;
    cursor = at + size(b);
    return axis === 'h'
      ? { memberId: b.memberId, patch: { x: Math.round(at) } }
      : { memberId: b.memberId, patch: { y: Math.round(at) } };
  });
  return patchEach(graph, parentRef, patches);
}

/**
 * Lay the selection edge-to-edge with a FIXED `gap` (the user-typed pitch). Unlike
 * {@link distributeSpacing} (which fits an equal gap WITHIN the current span, keeping
 * both ends anchored), this keeps only the FIRST item anchored and re-places each
 * subsequent item at `previous trailing edge + gap` — so the selection's overall size
 * follows from the gap (it grows/shrinks). `gap` 0 packs flush; a negative gap overlaps
 * by |gap| (no special case). The deterministic-pitch sibling of `distributeSpacing`.
 */
export function distributeByGap(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  axis: 'h' | 'v',
  gap: number,
): GroupGraph {
  const boxes = boxesFor(graph, parentRef, memberIds);
  if (boxes.length < 2) return graph;
  const lead = (b: Box) => (axis === 'h' ? b.x : b.y);
  const size = (b: Box) => (axis === 'h' ? b.w : b.h);
  const sorted = [...boxes].sort((a, b) => lead(a) - lead(b));
  let cursor = lead(sorted[0]) + size(sorted[0]); // first stays; trailing edge of it
  const patches = sorted.slice(1).map((b) => {
    const at = cursor + gap;
    cursor = at + size(b);
    return axis === 'h'
      ? { memberId: b.memberId, patch: { x: Math.round(at) } }
      : { memberId: b.memberId, patch: { y: Math.round(at) } };
  });
  return patchEach(graph, parentRef, patches);
}

// ── SNAP TO GRID — round each box's top-left to the nearest grid cell. ──

/** The board's dot-grid spacing (canvas-dot-grid default) — snap targets it so a
 *  snapped layout lands exactly on the visible dots. */
export const BOARD_GRID = 24;

/** Snap each selected box's top-left to the nearest `grid` multiple (align-to-grid). */
export function snapToGrid(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  grid: number,
): GroupGraph {
  if (!Number.isFinite(grid) || grid <= 0) return graph; // `grid <= 0` alone let NaN (NaN<=0 false) AND Infinity (0*Infinity=NaN) through → NaN positions
  const boxes = boxesFor(graph, parentRef, memberIds);
  if (boxes.length === 0) return graph;
  return patchEach(
    graph,
    parentRef,
    boxes.map((b) => ({
      memberId: b.memberId,
      patch: { x: Math.round(b.x / grid) * grid, y: Math.round(b.y / grid) * grid },
    })),
  );
}

// ── ARRANGE — reflow selected boxes by an injected placement (grid/column/row/circle). ──

/**
 * The shared geometry every placement receives for ONE box: the selection's top-left
 * anchor (`minX`/`minY`), the uniform column/row pitch (largest box dimension + gap),
 * the total `count`, the reading-order `index`, and the `box` itself. A placement maps
 * this to the box's new absolute top-left. This is the data half of the L069 primitive
 * — the mechanism computes the context once; the placement decides the shape.
 */
export interface PlaceContext {
  readonly index: number;
  readonly count: number;
  readonly minX: number;
  readonly minY: number;
  readonly colPitch: number;
  readonly rowPitch: number;
  readonly gap: number;
  readonly box: Box;
}

/** A placement: the injected capability that turns a {@link PlaceContext} into an
 *  absolute top-left. Grid, column, row, circle, spiral, diagonal — every arrangement
 *  is one of these functions. The engine never enumerates them. */
export type Placement = (ctx: PlaceContext) => { x: number; y: number };

/**
 * THE generative arrange primitive (L069). Reflows the selected boxes by handing each
 * box — in reading order (top→bottom, left→right, stable) — to an INJECTED
 * {@link Placement} that returns its new absolute top-left. Anchor = selection's
 * top-left; pitch = largest box dimension + `gap` (so nothing overlaps at uniform
 * spacing regardless of mixed sizes). The PLACEMENT is the only variable — grid,
 * column, row AND radial/circle (plus any future spiral/diagonal/masonry) all emerge
 * from this ONE body with ZERO branches. Pure graph→graph via `patchEach`; the shell
 * commits one undo step.
 *
 * This is the deeper primitive that dissolves the grid-bounded {@link arrangeUniform}:
 * `arrangeUniform`'s `colsFor` could only ever choose a COLUMN COUNT, so it was clay
 * for grids but LEGO for everything else — it can never express a circle. Injecting
 * the full position function (not just the column count) makes the primitive true
 * clay: an arrangement `arrangeUniform` could never produce (a circle) is now one
 * more DATA lambda, proving the mechanism generative (L069 emergence).
 */
export function arrangeBy(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  gap: number,
  place: Placement,
  order: (a: Box, b: Box) => number = (a, b) => a.y - b.y || a.x - b.x,
): GroupGraph {
  const boxes = boxesFor(graph, parentRef, memberIds);
  if (boxes.length < 2) return graph;
  const minX = minOf(boxes.map((b) => b.x));
  const minY = minOf(boxes.map((b) => b.y));
  const colPitch = maxOf(boxes.map((b) => b.w)) + gap;
  const rowPitch = maxOf(boxes.map((b) => b.h)) + gap;
  // The TRAVERSAL order is injectable too (L069 — both the order AND the position are DATA): the
  // default is reading order (top→bottom, left→right, stable) so every existing caller is byte-
  // unchanged; a sort arrangement injects a content comparator (alphabetical, by size) instead.
  const ordered = [...boxes].sort(order);
  const count = ordered.length;
  const patches = ordered.map((box, index) => {
    const { x, y } = place({ index, count, minX, minY, colPitch, rowPitch, gap, box });
    return { memberId: box.memberId, patch: { x: Math.round(x), y: Math.round(y) } };
  });
  return patchEach(graph, parentRef, patches);
}

/**
 * Flow placement — fill `colsFor(count)` columns row-major at uniform pitch. Grid
 * (`ceil√n`), column (`() => 1`) and row (`n => n`) are its three canonical lambdas.
 * The `colsFor` seam that {@link arrangeUniform} exposes is exactly this placement.
 */
export function flowPlacement(colsFor: (count: number) => number): Placement {
  return ({ index, count, minX, minY, colPitch, rowPitch }) => {
    const cols = Math.max(1, Math.min(count, Math.floor(colsFor(count)) || 1));
    const r = Math.floor(index / cols);
    const c = index % cols;
    return { x: minX + c * colPitch, y: minY + r * rowPitch };
  };
}

/**
 * Radial placement — space the boxes evenly on a circle, each box CENTRED on its ring
 * point, starting at 12 o'clock and going clockwise. Radius grows with count and pitch
 * (`count * pitch / 2π`, floored to one pitch so a 2-item ring stays separated) so the
 * boxes never overlap. Centre sits one radius below-right of the selection's top-left
 * anchor, keeping the whole ring on positive canvas. This is the arrangement the
 * column-count-only {@link arrangeUniform} could NEVER produce — the L069 emergence
 * proof that {@link arrangeBy} is a true generative primitive, not grid-bounded LEGO.
 */
export function radialPlacement(): Placement {
  return ({ index, count, minX, minY, colPitch, rowPitch, box }) => {
    const pitch = Math.max(colPitch, rowPitch);
    const radius = circleLayoutRadius(count, pitch); // ONE circle-radius SSOT (shared with the Arrange menu)
    const cx = minX + radius;
    const cy = minY + radius;
    const angle = (2 * Math.PI * index) / count - Math.PI / 2; // start at top, clockwise
    return { x: cx + radius * Math.cos(angle) - box.w / 2, y: cy + radius * Math.sin(angle) - box.h / 2 };
  };
}

/**
 * Masonry placement — pack variable-HEIGHT boxes into `colsFor(count)` fixed-width columns,
 * each box dropped into the currently-SHORTEST column (Pinterest / Milanote-style tight vertical
 * packing). This is the layout no uniform-pitch placement can express: grid/column/row assume a
 * fixed `rowPitch` (every row as tall as the tallest box), wasting space on a board of mixed-size
 * items (images + short notes); masonry uses each box's ACTUAL height so columns stay dense and
 * even. It is a STATEFUL placement — it accumulates a running bottom-Y per column across the
 * sequential (reading-order) calls {@link arrangeBy} makes, which the stateless grid/circle
 * placements don't need. Column x-pitch = `colPitch` (max width + gap, so fixed-width columns
 * never overlap); the fresh closure per call keeps it pure at the call site. The `arrangeBy`
 * comment predicted this (L069): masonry is one more DATA lambda, ZERO engine change.
 */
export function masonryPlacement(colsFor: (count: number) => number): Placement {
  const bottom: number[] = []; // running bottom-Y (relative to minY) per column
  return ({ index, count, minX, minY, colPitch, gap, box }) => {
    const cols = Math.max(1, Math.min(count, Math.floor(colsFor(count)) || 1));
    if (index === 0) { bottom.length = 0; for (let i = 0; i < cols; i++) bottom.push(0); }
    // Drop into the shortest column (first one on a tie → stable, left-biased).
    let sc = 0;
    for (let i = 1; i < cols; i++) if (bottom[i] < bottom[sc]) sc = i;
    const x = minX + sc * colPitch;
    const y = minY + bottom[sc];
    bottom[sc] += box.h + gap;
    return { x, y };
  };
}

/** Order comparators for the injectable {@link arrangeBy} traversal order — the SORT arrangements.
 *  `byTextAsc` alphabetises by the item's text (case-insensitive, numeric-aware so "item 2" < "item
 *  10"); `byAreaDesc` puts the biggest boxes first. A new sort criterion is one more comparator, ZERO
 *  engine change (the position stays whatever placement the row injects). */
export const byTextAsc = (a: Box, b: Box): number =>
  (a.text ?? '').localeCompare(b.text ?? '', undefined, { numeric: true, sensitivity: 'base' });
export const byAreaDesc = (a: Box, b: Box): number => b.w * b.h - a.w * a.h;
/** Rainbow sort — order items around the colour wheel (red → violet); achromatic (grey/black/white)
 *  and fill-less items rank LAST (hue null → +Infinity), so the spectrum reads clean with the greys
 *  gathered at the end. `hueOf` (item-fill) owns the parse; this is just the ORDER over it. */
export const byHue = (a: Box, b: Box): number =>
  (hueOf(a.fill) ?? Infinity) - (hueOf(b.fill) ?? Infinity);
/** Sort by completion, most-done FIRST — surfaces "what's nearly finished" at the top of the column.
 *  A card with no metric AND no checklist has no progress (→ -1), so it ranks LAST (like byHue's greys). */
export const byProgressDesc = (a: Box, b: Box): number => (b.progress ?? -1) - (a.progress ?? -1);
/** Sort by due date, SOONEST first — the compact chronological column (the ordered-list counterpart of
 *  the spatial timeline). Undated cards have no due (→ +Infinity), so they gather LAST. */
export const byDueAsc = (a: Box, b: Box): number => (a.due ?? Infinity) - (b.due ?? Infinity);

/**
 * Arrange the selection into a uniform-pitch flow — the {@link flowPlacement}
 * configuration of {@link arrangeBy}. The layout SHAPE is the injected
 * `colsFor(count) → columns` capability (enum-dissolution): grid, column, and row all
 * emerge from this ONE call with ZERO branches:
 *   • grid   → `colsFor = n => ceil(√n)`  (≈square)
 *   • column → `colsFor = () => 1`        (single vertical stack)
 *   • row    → `colsFor = n => n`         (single horizontal line)
 * Kept as the named flow seam its callers (#173/#129/#202) read against; behaviour is
 * byte-identical to the pre-#203 standalone body (now hosted by `arrangeBy`).
 */
export function arrangeUniform(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  gap: number,
  colsFor: (count: number) => number,
): GroupGraph {
  return arrangeBy(graph, parentRef, memberIds, gap, flowPlacement(colsFor));
}

/**
 * §9.1 — Arrange the selection into CLUSTERS by an injected facet (the "sort my board
 * into groups/areas by tag / kind / color / progress / anything" move). The graph-level
 * bridge over the pure {@link arrangeByField} leaf: extract each item's cluster key via
 * the INJECTED `keyOf` (the SAME criterion contract `similarIds` uses for Select-similar
 * — one extractor primitive, two consumers: filter there, PARTITION here), lay each
 * cluster as a tidy grid stacked vertically, and fold the returned positions with
 * `patchEach`. The engine never names a facet (L090) — tag/kind/fill below are call-site
 * lambdas, and a future facet (progress, owner, deadline) is one more DATA row with ZERO
 * engine change. Multi-key items (many tags) cluster under their FIRST key
 * (deterministic primary); keyless items share the '' cluster (sorts first — the
 * "untagged" pile). Connectors are excluded: they are position-less lines that re-derive
 * from their endpoints. Anchored at the selection's top-left so the sorted clusters
 * replace the selection footprint instead of jumping to the origin.
 */
export function arrangeByFacet(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  gap: number,
  keyOf: (item: BoardItem) => string | readonly string[],
): GroupGraph {
  const want = new Set(memberIds);
  const items = readFiniteItems(graph, parentRef).filter((i) => want.has(i.memberId) && !itemIsConnector(i));
  if (items.length < 2) return graph;
  const firstKey = (k: string | readonly string[]): string =>
    Array.isArray(k) ? (k.find((s) => typeof s === 'string' && s.length > 0) ?? '') : typeof k === 'string' ? k : '';
  const positions = arrangeByField(
    items.map((i) => ({ memberId: i.memberId, w: i.w, h: i.h, groupKey: firstKey(keyOf(i)) })),
    {
      colGap: gap,
      rowGap: gap,
      clusterGap: gap * 3,
      originX: minOf(items.map((i) => i.x)),
      originY: minOf(items.map((i) => i.y)),
    },
  );
  return patchEach(graph, parentRef, positions.map((p) => ({ memberId: p.memberId, patch: { x: p.x, y: p.y } })));
}

/**
 * §9.4 (continuous) — Arrange the selection along a NUMERIC axis (the "plot my cards by date /
 * price / progress" move), the CONTINUOUS sibling of {@link arrangeByFacet}: where that PARTITIONS
 * items into discrete clusters by a string key, this SCALES them onto a continuous plane by a
 * number. The graph-level bridge over the pure {@link arrangeByAxis} leaf — extract each item's
 * numeric via the INJECTED `valueOf` (returning `{ x, y? }`, the continuous analog of the discrete
 * `keyOf`), scale onto the selection's own footprint (in-place — the plot replaces the selection
 * area, never jumps to the origin), and fold the returned positions. Omitting `y` on every item
 * gives a 1-D TIMELINE; returning both gives a 2-D SCATTER — the DATA decides the mode (L090), the
 * engine never names a field. Items whose value is null/NaN park in the leaf's no-value pile
 * (below the plot) rather than being dropped. Colliding cards (e.g. same date) are spread by the
 * shared {@link resolveOverlaps} MTV pass (default on) so a dense timeline stays readable, while
 * each card stays as close to its true value as possible. Connectors are excluded. <2 nodes → no-op.
 *
 * LABELLED AXIS (`opts.showAxis`) — the continuous analog of {@link arrangeByFacetLabeled}'s region
 * headings: after plotting, drop the matching {@link axisTicks} as deterministic ghost-note VALUE
 * LABELS (X below the plot, Y down the left in scatter mode), formatted via `opts.format` (raw
 * number → human string: date / $ / %). So a scatter/timeline reads as a real CHART, not just moved
 * boxes. Idempotent: prior axis furniture is ALWAYS removed first (self-describing via
 * {@link itemIsAxisTick}), so re-plotting never accumulates labels.
 */
export function arrangeSelectionOnAxis(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  valueOf: (item: BoardItem) => { x: number | null; y?: number | null },
  opts?: { deOverlap?: boolean; gap?: number; showAxis?: boolean; format?: (v: number) => string; formatX?: (v: number) => string; formatY?: (v: number) => string } & Pick<ArrangeByAxisOptions, 'domainX' | 'domainY' | 'invertY'>,
): GroupGraph {
  const boardId = typeof (parentRef.parts as Record<string, unknown> | undefined)?.board === 'string'
    ? ((parentRef.parts as Record<string, unknown>).board as string)
    : '';

  // Self-clean: remove EVERY existing axis-tick label first so re-plotting (even by a different
  // field) never accumulates furniture — the axis is re-derived each time (like region headings).
  let g = graph;
  for (const t of readItems(g, parentRef).filter(itemIsBoardFurniture)) g = removeItem(g, parentRef, t.memberId);

  const want = new Set(memberIds);
  const items = readFiniteItems(g, parentRef).filter((i) => want.has(i.memberId) && !itemIsConnector(i) && !itemIsBoardFurniture(i));
  if (items.length < 2) return g;

  // Plot onto the selection's own footprint so the arrangement stays IN PLACE (like arrangeByFacet):
  // the axis spans the box the selection currently occupies, floored so a tiny selection still reads.
  const originX = minOf(items.map((i) => i.x));
  const originY = minOf(items.map((i) => i.y));
  const spanX = Math.max(240, maxOf(items.map((i) => i.x + i.w)) - originX);
  const spanY = Math.max(240, maxOf(items.map((i) => i.y + i.h)) - originY);

  const axisItems: AxisItem[] = items.map((i) => {
    const v = valueOf(i);
    return { memberId: i.memberId, w: i.w, h: i.h, valueX: v.x, valueY: v.y };
  });
  const plot = axisPlot(axisItems, { originX, originY, spanX, spanY, domainX: opts?.domainX, domainY: opts?.domainY, invertY: opts?.invertY });
  let placed = plot.placed;

  // Spread only the ON-AXIS cards (the pile is already a clean row); minimal-translation MTV keeps
  // each card near its true value while removing overlaps. Off by opts.deOverlap === false.
  if (opts?.deOverlap !== false) {
    const byId = new Map(items.map((i) => [i.memberId, i]));
    const onAxis = placed.filter((p) => p.onAxis);
    const spread = resolveOverlaps(
      onAxis.map((p) => ({ memberId: p.memberId, x: p.x, y: p.y, w: byId.get(p.memberId)!.w, h: byId.get(p.memberId)!.h })),
      { gap: opts?.gap ?? 12 },
    );
    const spreadById = new Map(spread.map((s) => [s.memberId, s]));
    placed = placed.map((p) => (p.onAxis ? { ...p, x: spreadById.get(p.memberId)!.x, y: spreadById.get(p.memberId)!.y } : p));
  }

  g = patchEach(g, parentRef, placed.map((p) => ({ memberId: p.memberId, patch: { x: p.x, y: p.y } })));
  if (opts?.showAxis) g = materializeAxisLabels(g, parentRef, boardId, plot, opts.formatX ?? opts.format, opts.formatY ?? opts.format);
  return g;
}

/** Prefix + box size for the materialised axis-tick value labels (§9.4 labelled). */
export const AXIS_TICK_PREFIX = 'axis-tick:';
const AXIS_LABEL_W = 56;
const AXIS_LABEL_H = 22;
const AXIS_LABEL_GAP = 8;

/** True for a materialised axis-tick label (self-describing — excluded from plotting/selection by
 *  SHAPE, never a kind literal), so re-plotting re-derives the axis instead of moving old labels. */
export function itemIsAxisTick(item: BoardItem): boolean {
  return item.memberId.startsWith(AXIS_TICK_PREFIX) || item.extra?.axisTick === true;
}

/** True for ANY derived board FURNITURE — a region heading OR an axis tick — i.e. an item the board
 *  GENERATED to label an arrangement, never user content. The ONE predicate every content operation
 *  (clustering, plotting, select-similar order, recolour, export) excludes so furniture is never
 *  treated as data and a new arrangement always clears the prior one's furniture (L063 — solve the
 *  category, so the NEXT furniture type is one `||` here, not another edit at every call site). */
export function itemIsBoardFurniture(item: BoardItem): boolean {
  return itemIsRegionHeading(item) || itemIsAxisTick(item);
}

/** Drop the axis VALUE LABELS for a plot as deterministic ghost notes: X ticks in a row just below
 *  the plot, Y ticks (scatter only) down the left edge. Ids are `axis-tick:<axis>:<value>` so a
 *  re-plot replaces them. Blind to the field — labels are formatted by the caller's `format`. */
function materializeAxisLabels(
  graph: GroupGraph,
  parentRef: AddressRef,
  boardId: string,
  plot: ReturnType<typeof axisPlot>,
  formatX?: (v: number) => string,
  formatY?: (v: number) => string,
): GroupGraph {
  let g = graph;
  const place = (axis: 'x' | 'y', value: number, x: number, y: number, text: string): void => {
    const id = `${AXIS_TICK_PREFIX}${axis}:${value}`;
    g = placeItem(g, parentRef, {
      memberId: id,
      nodeRef: itemRef(boardId, id),
      kind: 'note',
      x,
      y,
      w: AXIS_LABEL_W,
      h: AXIS_LABEL_H,
      text,
      // Self-describing ghost furniture — bare look, excluded from clustering/plot/select by shape.
      extra: { axisTick: true, containerVariant: 'ghost' },
    });
  };
  if (plot.domainX) {
    const xEdge = (plot.twoD ? plot.originY + plot.spanY : plot.laneY) + AXIS_LABEL_GAP;
    const labels = axisTickLabels(axisTicks(plot.domainX, plot.spanX, plot.originX), { orientation: 'x', edge: xEdge, labelW: AXIS_LABEL_W, labelH: AXIS_LABEL_H, format: formatX });
    for (const l of labels) place('x', l.value, l.x, l.y, l.text);
  }
  if (plot.twoD && plot.domainY) {
    const yEdge = plot.originX - AXIS_LABEL_W - AXIS_LABEL_GAP;
    const labels = axisTickLabels(axisTicks(plot.domainY, plot.spanY, plot.originY, { invert: plot.invertY }), { orientation: 'y', edge: yEdge, labelW: AXIS_LABEL_W, labelH: AXIS_LABEL_H, format: formatY });
    for (const l of labels) place('y', l.value, l.x, l.y, l.text);
  }
  return g;
}

/**
 * §9.5 — Arrange the selection as a TIMELINE / ROADMAP (Gantt): a CONTINUOUS X axis (plot each card
 * by a number — date / order / sprint via the injected `valueOf`) crossed with DISCRETE Y SWIMLANES
 * (one lane per key via the injected `laneOf` — owner / status / workstream). The genuine
 * COMPOSITION of the two arrange families that neither makes alone; the graph bridge over the pure
 * {@link arrangeTimelineLanes} leaf. Cards are placed by value within their lane band; each lane is
 * de-overlapped INDEPENDENTLY (`resolveOverlaps` per lane) so lanes never bleed into each other, and
 * each lane gets a labelled header (a region-heading ghost note at its left, via {@link regionLabelFor}).
 * `laneKeys` forces lane order AND keeps empty lanes (a persisted board). Idempotent: prior furniture
 * (region headings AND axis ticks) is removed first (L063 {@link itemIsBoardFurniture}). Connectors +
 * furniture are excluded from the plot. <2 nodes → no-op. Blind to both fields (L090).
 */
export function arrangeSelectionAsTimeline(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  valueOf: (item: BoardItem) => number | null,
  laneOf: (item: BoardItem) => string,
  opts?: { laneKeys?: readonly string[]; labelMap?: Record<string, string>; emptyLabel?: string; deOverlap?: boolean; gap?: number; laneHeight?: number },
): GroupGraph {
  const boardId = typeof (parentRef.parts as Record<string, unknown> | undefined)?.board === 'string'
    ? ((parentRef.parts as Record<string, unknown>).board as string)
    : '';

  let g = graph;
  for (const t of readItems(g, parentRef).filter(itemIsBoardFurniture)) g = removeItem(g, parentRef, t.memberId);

  const want = new Set(memberIds);
  const items = readFiniteItems(g, parentRef).filter((i) => want.has(i.memberId) && !itemIsConnector(i) && !itemIsBoardFurniture(i));
  if (items.length < 2) return g;

  const originX = minOf(items.map((i) => i.x));
  const originY = minOf(items.map((i) => i.y));
  const spanX = Math.max(240, maxOf(items.map((i) => i.x + i.w)) - originX);
  const laneHeight = opts?.laneHeight && opts.laneHeight > 0 ? opts.laneHeight : Math.max(80, maxOf(items.map((i) => i.h)) + 40);

  const laneItems = items.map((i) => ({ memberId: i.memberId, w: i.w, h: i.h, valueX: valueOf(i), laneKey: laneOf(i) }));
  const layout = arrangeTimelineLanes(laneItems, { originX, originY, spanX, laneHeight, laneGap: 16, laneKeys: opts?.laneKeys });

  let positions = layout.positions;
  // De-overlap each lane INDEPENDENTLY so cards sharing an X stack within their band without a lane
  // ever bleeding into its neighbour (minimal-translation MTV keeps each card near its true X).
  if (opts?.deOverlap !== false) {
    const byId = new Map(items.map((i) => [i.memberId, i]));
    const laneOfId = new Map(laneItems.map((li) => [li.memberId, li.laneKey]));
    const byLane = new Map<string, ArrangedPositionLike[]>();
    for (const p of positions) {
      const k = laneOfId.get(p.memberId) ?? '';
      const list = byLane.get(k) ?? [];
      list.push(p);
      byLane.set(k, list);
    }
    const moved = new Map<string, { x: number; y: number }>();
    for (const [, ps] of byLane) {
      const spread = resolveOverlaps(ps.map((p) => ({ memberId: p.memberId, x: p.x, y: p.y, w: byId.get(p.memberId)!.w, h: byId.get(p.memberId)!.h })), { gap: opts?.gap ?? 12 });
      for (const s of spread) moved.set(s.memberId, { x: s.x, y: s.y });
    }
    positions = positions.map((p) => ({ ...p, ...(moved.get(p.memberId) ?? {}) }));
  }
  g = patchEach(g, parentRef, positions.map((p) => ({ memberId: p.memberId, patch: { x: p.x, y: p.y } })));

  // One labelled lane header per band (region-heading furniture, so it self-cleans on re-arrange).
  const LANE_LABEL_W = 120;
  for (const lane of layout.lanes) {
    const label = regionLabelFor(lane.key, opts?.labelMap, opts?.emptyLabel);
    const id = `${REGION_HEADING_PREFIX}lane:${encodeURIComponent(lane.key)}`;
    g = placeItem(g, parentRef, {
      memberId: id,
      nodeRef: itemRef(boardId, id),
      kind: 'note',
      x: originX - LANE_LABEL_W - 12,
      y: lane.y + lane.h / 2 - 16,
      w: LANE_LABEL_W,
      h: 32,
      text: `${label} · ${lane.count}`,
      extra: { regionHeading: true, regionFacet: 'lane', groupKey: lane.key, containerVariant: 'ghost' },
    });
  }
  return g;
}

type ArrangedPositionLike = { readonly memberId: string; readonly x: number; readonly y: number };

/** Deterministic id prefix + band height for the labelled-region headings (§9.1). Ids are
 *  derived from facet+key so re-arranging REPLACES headings instead of accumulating them. */
export const REGION_HEADING_PREFIX = 'region-heading:';
const REGION_HEADING_BAND = 44;

/** True for a materialised region-heading item (self-describing — the board excludes these from
 *  clustering, selection-similar, export-as-content, etc. by SHAPE, never a kind literal). */
export function itemIsRegionHeading(item: BoardItem): boolean {
  return item.memberId.startsWith(REGION_HEADING_PREFIX) || item.extra?.regionHeading === true;
}

/**
 * §9.1 (labelled) — arrange the selection into clusters by a facet AND drop a labelled heading
 * over each cluster, so "Group by tag/kind/colour" produces LABELLED GROUP AREAS, not just moved
 * boxes (a user: "sort them into different groups areas on my board into the different tags"). The
 * heading half of the region primitive: `arrangeByFieldWithRegions` reserves a header band above
 * each cluster (items pushed down), and `regionHeadingSpecs` turns each region into a placeable
 * label. Headings are placed as note items with DETERMINISTIC ids (`region-heading:<facet>:<key>`)
 * so this is pure + idempotent — re-running (even by a DIFFERENT facet) first removes EVERY prior
 * region heading (`itemIsRegionHeading`), so labels never accumulate or go stale. The engine never
 * names a facet (L090); `facetId` + `labelMap` + `keyOf` are all caller DATA. Connectors and prior
 * headings are excluded from clustering. Anchored at the selection's top-left.
 */
export function arrangeByFacetLabeled(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  gap: number,
  keyOf: (item: BoardItem) => string | readonly string[],
  opts: {
    facetId: string;
    labelMap?: Record<string, string>;
    emptyLabel?: string;
    /** The cluster GEOMETRY — injected so the SAME self-clean + labelled-heading wrapper produces
     *  either the default row-grid groups ({@link arrangeByFieldWithRegions}) OR a horizontal
     *  KANBAN ({@link arrangeColumns}), zero duplicated heading code (L069). Default = row-grid. */
    layout?: (items: readonly ArrangeItem[], o?: ArrangeByFieldOptions) => ClusterLayout;
  },
): GroupGraph {
  const boardId = typeof (parentRef.parts as Record<string, unknown> | undefined)?.board === 'string'
    ? ((parentRef.parts as Record<string, unknown>).board as string)
    : '';

  // Self-clean: remove EVERY existing region heading (any facet) so re-arranging never accumulates.
  let g = graph;
  for (const h of readItems(g, parentRef).filter(itemIsBoardFurniture)) g = removeItem(g, parentRef, h.memberId);

  const want = new Set(memberIds);
  const items = readFiniteItems(g, parentRef).filter((i) => want.has(i.memberId) && !itemIsConnector(i) && !itemIsBoardFurniture(i));
  if (items.length < 2) return g;

  const firstKey = (k: string | readonly string[]): string =>
    Array.isArray(k) ? (k.find((s) => typeof s === 'string' && s.length > 0) ?? '') : typeof k === 'string' ? k : '';
  const originX = minOf(items.map((i) => i.x));
  const originY = minOf(items.map((i) => i.y));
  const { positions, regions } = (opts.layout ?? arrangeByFieldWithRegions)(
    items.map((i) => ({ memberId: i.memberId, w: i.w, h: i.h, groupKey: firstKey(keyOf(i)) })),
    { colGap: gap, rowGap: gap, clusterGap: gap * 3, originX, originY, headerReserve: REGION_HEADING_BAND },
  );
  g = patchEach(g, parentRef, positions.map((p) => ({ memberId: p.memberId, patch: { x: p.x, y: p.y } })));

  const specs = regionHeadingSpecs(regions, { labelMap: opts.labelMap, emptyLabel: opts.emptyLabel, showCount: true });
  for (const s of specs) {
    const id = REGION_HEADING_PREFIX + opts.facetId + ':' + encodeURIComponent(s.key);
    g = placeItem(g, parentRef, {
      memberId: id,
      nodeRef: itemRef(boardId, id),
      kind: 'note',
      x: s.x,
      y: s.y,
      w: s.w > 0 ? s.w : 160,
      h: Math.max(REGION_HEADING_BAND - gap, 24),
      text: s.text,
      // Self-describing so the board treats it as a heading (bare/ghost look, excluded from
      // clustering) via SHAPE, never a kind literal.
      extra: { regionHeading: true, regionFacet: opts.facetId, groupKey: s.key, containerVariant: 'ghost' },
    });
  }
  return g;
}

/** Column-header band height + row-header band width for the labelled matrix (§9.3). */
const MATRIX_COL_BAND = REGION_HEADING_BAND;
const MATRIX_ROW_BAND = 150;

/**
 * §9.3 (cont.19) — arrange the selection into a 2-FACET MATRIX (cross-tab) and drop labelled
 * column + row headers, so a board becomes a priority quadrant / effort×impact / status×colour
 * grid, not just moved boxes. The 2-D sibling of {@link arrangeByFacetLabeled}: two injected
 * `keyOf` extractors (the SAME contract Select-similar/Group-by inject into one axis) precompute
 * each item's `keyX`/`keyY`, the blind {@link arrangeMatrix} engine solves the aligned grid
 * geometry (uniform column widths / row heights, header bands), and this drops one heading note
 * per column (top band) + per row (left band). Headers reuse the SAME `region-heading:` prefix as
 * the 1-D facets so re-arranging (even by a different facet or back to a group) self-cleans them —
 * no accumulation. The engine never names a facet (L090); `facetIdX/Y` + `labelMapX/Y` + the two
 * `keyOf` are all caller DATA. `axisKeysX/Y` (optional) force a fixed quadrant grid with visible
 * empty cells (the empty Eisenhower quadrant still shows as a drop zone). Anchored at the
 * selection's top-left; lock-safe (the caller filters via `unlockedOf`).
 */
export function arrangeByMatrixLabeled(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  keyOfX: (item: BoardItem) => string | readonly string[],
  keyOfY: (item: BoardItem) => string | readonly string[],
  gap: number,
  opts: {
    facetIdX: string;
    facetIdY: string;
    labelMapX?: Record<string, string>;
    labelMapY?: Record<string, string>;
    emptyLabelX?: string;
    emptyLabelY?: string;
    axisKeysX?: readonly string[];
    axisKeysY?: readonly string[];
  },
): GroupGraph {
  const boardId = typeof (parentRef.parts as Record<string, unknown> | undefined)?.board === 'string'
    ? ((parentRef.parts as Record<string, unknown>).board as string)
    : '';

  // Self-clean: remove EVERY existing region heading (any facet, 1-D or matrix) so re-arranging
  // never accumulates headers.
  let g = graph;
  for (const h of readItems(g, parentRef).filter(itemIsBoardFurniture)) g = removeItem(g, parentRef, h.memberId);

  const want = new Set(memberIds);
  const items = readFiniteItems(g, parentRef).filter((i) => want.has(i.memberId) && !itemIsConnector(i) && !itemIsBoardFurniture(i));
  if (items.length < 2) return g;

  const firstKey = (k: string | readonly string[]): string =>
    Array.isArray(k) ? (k.find((s) => typeof s === 'string' && s.length > 0) ?? '') : typeof k === 'string' ? k : '';
  const originX = minOf(items.map((i) => i.x));
  const originY = minOf(items.map((i) => i.y));

  const { positions, colRegions, rowRegions } = arrangeMatrix(
    items.map((i) => ({ memberId: i.memberId, w: i.w, h: i.h, keyX: firstKey(keyOfX(i)), keyY: firstKey(keyOfY(i)) })),
    {
      cellGap: gap,
      itemGap: gap,
      cellPad: gap,
      originX,
      originY,
      colHeaderBand: MATRIX_COL_BAND,
      rowHeaderBand: MATRIX_ROW_BAND,
      colKeys: opts.axisKeysX,
      rowKeys: opts.axisKeysY,
    },
  );
  g = patchEach(g, parentRef, positions.map((p) => ({ memberId: p.memberId, patch: { x: p.x, y: p.y } })));

  // Drop one heading note per column (top band) and per row (left band). Deterministic ids per
  // axis+key so re-running replaces, never accumulates.
  const placeHeading = (id: string, text: string, x: number, y: number, w: number, h: number, facet: string, key: string) => {
    g = placeItem(g, parentRef, {
      memberId: id,
      nodeRef: itemRef(boardId, id),
      kind: 'note',
      x,
      y,
      w: w > 0 ? w : 140,
      h: Math.max(h, 24),
      text,
      extra: { regionHeading: true, regionFacet: facet, groupKey: key, containerVariant: 'ghost' },
    });
  };
  for (const c of colRegions) {
    const label = regionLabelFor(c.key, opts.labelMapX, opts.emptyLabelX);
    placeHeading(REGION_HEADING_PREFIX + opts.facetIdX + ':col:' + encodeURIComponent(c.key), `${label} · ${c.count}`, c.x, c.y, c.w, Math.max(MATRIX_COL_BAND - gap, 24), opts.facetIdX, c.key);
  }
  for (const r of rowRegions) {
    const label = regionLabelFor(r.key, opts.labelMapY, opts.emptyLabelY);
    placeHeading(REGION_HEADING_PREFIX + opts.facetIdY + ':row:' + encodeURIComponent(r.key), `${label} · ${r.count}`, r.x, r.y, Math.max(MATRIX_ROW_BAND - gap, 24), r.h, opts.facetIdY, r.key);
  }
  return g;
}

/** Arrange into a ≈square grid — the `colsFor = ceil(√n)` configuration of
 *  {@link arrangeUniform}. Kept as a named helper so its callers (#173/#129) read
 *  clearly; behaviour is byte-identical to the pre-#202 standalone implementation. */
export function tidyGrid(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  gap: number,
): GroupGraph {
  return arrangeUniform(graph, parentRef, memberIds, gap, (n) => Math.ceil(Math.sqrt(n)));
}

/**
 * §9.4 (cont.22) — SPREAD OUT: nudge overlapping items apart (leaving `gap`) while PRESERVING the
 * rough layout — the "I pasted a pile of stickies, un-stack them" action. Distinct from every arrange
 * (which imposes a NEW structure); this only separates collisions via the pure {@link resolveOverlaps}
 * relaxation. LOCKED items are passed as PINNED (immovable anchors) — the movable items flow around
 * them — so this is the ONE geometry op that must NOT route through `unlockedOf` (which would drop the
 * locked items and let movers land on top of them). Connectors + region headings are excluded (they
 * have no meaningful footprint). Only movable items are re-committed; a pinned item's position is
 * returned unchanged so its patch is a no-op. <2 items → no-op.
 */
export function spreadOutOverlaps(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  gap: number,
): GroupGraph {
  const want = new Set(memberIds);
  const items = readFiniteItems(graph, parentRef).filter(
    (i) => want.has(i.memberId) && !itemIsConnector(i) && !itemIsBoardFurniture(i),
  );
  if (items.length < 2) return graph;
  const positions = resolveOverlaps(
    items.map((i) => ({ memberId: i.memberId, x: i.x, y: i.y, w: i.w, h: i.h, pinned: itemIsLocked(i) })),
    { gap },
  );
  const byId = new Map(items.map((i) => [i.memberId, i]));
  // Only re-commit items that actually moved AND are not locked (a locked item never moves).
  const patches = positions
    .filter((p) => {
      const it = byId.get(p.memberId);
      return it && !itemIsLocked(it) && (p.x !== it.x || p.y !== it.y);
    })
    .map((p) => ({ memberId: p.memberId, patch: { x: p.x, y: p.y } }));
  return patches.length > 0 ? patchEach(graph, parentRef, patches) : graph;
}

/**
 * §9.5 (cont.23) — RECOLOUR the selection to a named PALETTE (theme). Reads the selection (skipping
 * connectors + region headings), sorts by reading order (y then x) so the `cycleAssign` flows
 * spatially (ordering lives HERE, not in the pure leaf — Codex), runs the injected `assign` strategy
 * via {@link recolorToPalette}, and paints each item through the SAME `setStackFill` SSOT the quick-
 * fill/Style editor use. A no-op skip when the item is already that colour. Locked items are dropped
 * by the caller's `unlockedOf` (recolour is an appearance mutation, frozen like every other). The
 * palette + assign are caller DATA — the engine never names a theme (L090).
 */
export function recolorSelectionToPalette(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  palette: BoardPalette,
  assign: PaletteAssign,
): GroupGraph {
  const want = new Set(memberIds);
  const items = readItems(graph, parentRef)
    .filter((i) => want.has(i.memberId) && !itemIsConnector(i) && !itemIsBoardFurniture(i))
    .sort((a, b) => a.y - b.y || a.x - b.x); // reading order → predictable cycle
  if (items.length === 0) return graph;
  const patches = recolorToPalette(
    items.map((i) => ({ memberId: i.memberId, fill: itemFillColor(i) })),
    palette,
    assign,
  );
  const colorById = new Map(patches.map((p) => [p.memberId, p.color]));
  const byId = new Map(items.map((i) => [i.memberId, i]));
  let g = graph;
  for (const [memberId, color] of colorById) {
    const it = byId.get(memberId);
    if (!it || itemFillColor(it) === color) continue; // already that colour → no-op skip
    const stack = (it.extra?.visualLayerStack as VisualLayerStackRecord | undefined) ?? emptyStack(parentRef);
    g = patchItem(g, parentRef, memberId, { visualLayerStack: setStackFill(stack, color, BOARD_ITEM_LAYER_REGISTRY) });
  }
  return g;
}

/**
 * cont.42/43 — COLOUR BY FACET (by-group): paint every selected item that shares a facet VALUE the
 * SAME palette colour, so a mixed board becomes colour-coded groups in one click ("colour by tag / by
 * type"). This is the THIRD organise axis after arrange-by-facet (position) and focus-by-facet (dim),
 * and it reuses the SAME {@link recolorSelectionToPalette} engine (lock-safe, no-op-skip, readable
 * ink) via the trivial `fixedColorAssign` bridge — ZERO new colour/apply code.
 *
 * cont.43 — the value→colour mapping is now STABLE board-wide: it is computed by `facetColorAssignment`
 * over ALL non-connector board items (not just the selection), in the facet's alphabetical value
 * order. So a given value ("idea") always gets the same colour regardless of which subset is selected
 * or where the notes sit — colouring the left half then the right half of a board by tag now yields
 * CONSISTENT colours (the Trello/Miro/Linear stable-label convention), where the old reading-order
 * assignment drifted a value's colour with the selection. The assignment also owns the value→colour
 * SSOT, so a legend can render the exact colours painted. L090/L098: `facetColorAssignment` is a blind
 * facet leaf (a `string[]` palette, never a board type); the wrapper feeds it the extractor. No-op
 * (`=== graph`) when nothing in the selection carries the facet.
 */
export function recolorSelectionByFacet(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  palette: BoardPalette,
  extractor: FacetExtractor<BoardItem>,
): GroupGraph {
  const want = new Set(memberIds);
  // Assign colours over ALL colourable items → a value's colour is board-wide stable, not selection-
  // relative (connectors/region-headings never carry a content facet, so exclude them from the order).
  const allItems = readItems(graph, parentRef).filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
  const assignment = facetColorAssignment(allItems, extractor, palette.colors);
  const colorByMember = new Map<string, string>();
  for (const it of allItems) {
    if (!want.has(it.memberId)) continue;
    const color = assignment.colorOfEntry(it);
    if (color !== null) colorByMember.set(it.memberId, color);
  }
  if (colorByMember.size === 0) return graph; // nothing selected carries the facet → no-op
  return recolorSelectionToPalette(graph, parentRef, memberIds, palette, fixedColorAssign(colorByMember));
}

/** cont.42 — the colourable FACETS (DATA catalog, mirroring BOARD_PALETTES / GRAPH_LAYOUTS): each row
 *  is "Color by <facet>", ZERO row code. A new colourable facet is one entry (L069/L090). We colour by
 *  `tag` and by `kindFamily` (type); colouring by `colorFamily` would be circular (colour by colour),
 *  so it is deliberately absent. `facet` is the BOARD_ITEM_FACETS id that also keys the `distinctFacetValues`
 *  gate, so the row's presence and its colouring read the SAME extractor (one SSOT). */
const COLOR_BY_FACETS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly facet: string;
  readonly extractor: FacetExtractor<BoardItem>;
}> = [
  { id: 'tag', label: 'Color by tag', facet: 'tag', extractor: BOARD_ITEM_FACETS.tag },
  { id: 'type', label: 'Color by type', facet: 'kindFamily', extractor: BOARD_ITEM_FACETS.kindFamily },
];

/** The BOARD_ITEM_FACETS ids that HAVE a "Colour by <facet>" action (cont.42) — the SSOT for which
 *  facets a colour legend is meaningful for. `colorFamily` is absent (colouring by colour is circular),
 *  so a colour-family chip must NOT carry a colour-by swatch. Derived from the catalog, never re-listed. */
export const COLOR_BY_FACET_KEYS: readonly string[] = COLOR_BY_FACETS.map((f) => f.facet);

/**
 * §9.6 (cont.24) — HARMONISE the selection from an anchor colour: read the reading-first FILLED
 * item's colour as the seed, generate a colour-theory `scheme` from it ({@link harmonize} — one HSL-
 * rotation engine), and recolour the (unlocked) selection to that generated palette via the SAME
 * cont.23 recolour path. So "pick a sticky's colour → theme the whole board complementary / triadic /
 * analogous" is ONE mechanism × an injected DATA scheme (L069), composing cont.18 (`parseRgb`/hue) +
 * cont.23 (`recolorSelectionToPalette`). No filled item → no seed → no-op (the rows are gated on
 * `anchorHasFill`). Locked items keep their colour (excluded from the recolour); connectors + region
 * headings never recoloured. The engine never names a scheme (L090).
 */
export function harmonizeSelectionFromAnchor(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  scheme: HarmonyScheme,
): GroupGraph {
  const want = new Set(memberIds);
  const items = readItems(graph, parentRef)
    .filter((i) => want.has(i.memberId) && !itemIsConnector(i) && !itemIsRegionHeading(i))
    .sort((a, b) => a.y - b.y || a.x - b.x); // reading order → the top-left filled item is the seed
  const seed = items.map((i) => itemFillColor(i)).find((c): c is string => typeof c === 'string');
  const colors = harmonize(seed, scheme);
  if (colors.length === 0) return graph; // no seed / unparseable → no-op
  const palette: BoardPalette = { id: `harmony:${scheme.id}`, label: scheme.label, colors };
  const unlockedIds = items.filter((i) => !itemIsLocked(i)).map((i) => i.memberId);
  return recolorSelectionToPalette(graph, parentRef, unlockedIds, palette, cycleAssign);
}

// ── MIND-MAP AUTO-LAYOUT — reflow a connector-linked graph into a tidy tree. ──
//
// The topology-aware sibling of the geometric layout ops above: where `tidyGrid`
// /`distributeBoxes` ignore relationships and pack by index, this reads the SAME
// `kind:'connector'` members (#98, carrying `extra.from/toMemberId`) that #159's
// quick-create spawns and arranges the connected notes into a classic left→right
// tidy tree (Reingold–Tilford shape: depth = column, children stacked + parent
// centred on its child span). The connectors themselves are never moved — they are
// position-less lines that re-derive from their endpoints, so re-placing the nodes
// re-routes every relationship for free. Pure + deterministic (no ids minted, no
// clock) → unit-testable; the gesture shell commits it as ONE undoable batch.

// Graph-layout types + the tidy-tree solver moved to the pure `show/graph-layout` leaf
// (cont.25) so tree / layered / radial are ONE injected-strategy family. These aliases keep
// the #161 call sites (`planOutlineMindMap`, the mind-map tests) working unchanged (L030 —
// one SSOT for the solver, no duplicate).
type LayoutNode = GraphNode;
type LayoutEdge = GraphEdge;
export type TreeLayoutOptions = GraphLayoutOptions;
/** #161 tidy-tree solver — now the `tidyTreeLayout` strategy in `show/graph-layout`. */
export const computeTreeLayout = tidyTreeLayout;

/**
 * The generic graph-layout ENGINE (cont.25): reflow the connector-linked selection BY its graph
 * structure, using an injected {@link GraphLayoutStrategy}. Reads connectors from the WHOLE board
 * (a connector need not itself be selected — only its two endpoints) via the shared
 * `buildRelationGraph` edge SSOT, keeps only edges whose BOTH endpoints are selected non-connector
 * nodes, runs the strategy to LOCAL coordinates, anchors the result at the selection's current
 * top-left, and `patchEach`-commits as ONE undoable batch. Edge-AWARE — the whole-graph sibling of
 * the edge-BLIND `arrangeBy` (kept a SEPARATE seam per Codex: per-box vs whole-graph is a real
 * boundary). LOCKED nodes still define the topology (so a locked parent never orphans its subtree)
 * but their final position patch is OMITTED — they are immovable PINS, exactly like
 * `spreadOutOverlaps` (this is the fix to #161's old `unlockedOf` bug). No-op on <2 nodes, no
 * linking connector, or an empty strategy result. Connectors are never moved — they re-route.
 */
export function arrangeByGraph(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  strategy: GraphLayoutStrategy,
  opts: GraphLayoutOptions = {},
): GroupGraph {
  const want = new Set(memberIds);
  const items = readFiniteItems(graph, parentRef); // sanitize coords → span/anchor math can't overflow
  const nodeItems = items.filter((i) => want.has(i.memberId) && !itemIsConnector(i));
  if (nodeItems.length < 2) return graph;
  const nodeSet = new Set(nodeItems.map((i) => i.memberId));
  const nodes: GraphNode[] = nodeItems.map((i) => ({ memberId: i.memberId, w: i.w, h: i.h, x: i.x, y: i.y }));
  // Reuse the connector→edge SSOT; keep only edges internal to the selection.
  const edges: GraphEdge[] = buildRelationGraph(items).edges
    .filter((e) => nodeSet.has(e.from) && nodeSet.has(e.to))
    .map((e) => ({ from: e.from, to: e.to }));
  if (edges.length === 0) return graph;
  const local = strategy(nodes, edges, opts);
  if (local.size === 0) return graph;
  const laid = nodeItems.filter((i) => local.has(i.memberId));
  const anchorX = minOf(laid.map((i) => i.x));
  const anchorY = minOf(laid.map((i) => i.y));
  // Locked nodes anchored the topology but must not move — omit their patches (pinned).
  const movers = laid.filter((i) => !itemIsLocked(i));
  if (movers.length === 0) return graph;
  return patchEach(
    graph,
    parentRef,
    movers.map((i) => {
      const p = local.get(i.memberId)!;
      return { memberId: i.memberId, patch: { x: Math.round(anchorX + p.x), y: Math.round(anchorY + p.y) } };
    }),
  );
}

/**
 * #161 — arrange the selection into a tidy mind-map tree. Now a thin wrapper over the generic
 * {@link arrangeByGraph} engine with the `tidyTreeLayout` strategy (L030/L100 — the read/anchor/
 * commit is shared with the flowchart + radial layouts, not duplicated per shape). Anchored at the
 * selection's current top-left; connectors untouched; no-op on <2 nodes or no linking connector.
 * LOCKED nodes now anchor the topology as pins (via the engine) rather than being dropped.
 */
export function arrangeMindMap(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  opts: TreeLayoutOptions = {},
): GroupGraph {
  return arrangeByGraph(graph, parentRef, memberIds, tidyTreeLayout, opts);
}

// ── MIND-MAP OUTLINE EXPORT — serialize the connector tree to indented text. ──
//
// The capstone completing the mind-map authoring↔structure loop (#159 build → #161 tidy
// → #162/#163 focus → #165 colour → #184 EXPORT): read the tree BACK OUT as a Markdown
// outline for a doc/email/notes app (MindNode/XMind/Workflowy canon). Pure and blind —
// same connector adjacency `arrangeMindMap` lays out, walked depth-first into bullets.

/** One line of the outline: a node's text at its tree depth (0 = a root). */
export interface OutlineLine {
  readonly depth: number;
  readonly text: string;
  /** The board card this line came from, when the outline was walked from real board members (mindMapOutline).
   *  Absent when the line was PARSED from text (OPML/FreeMind/indented paste — no card exists yet). Lets an
   *  interactive outline jump to the card without a fragile text match. */
  readonly memberId?: string;
}

/** A node's display text, collapsed to a single trimmed line (an outline row is one line). */
function outlineText(item: BoardItem): string {
  const raw = typeof item.text === 'string' ? item.text : '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 0 ? flat : '(untitled)';
}

/**
 * Serialize the selected mind-map nodes into an ordered, indented outline. Roots are the
 * selected nodes with no INCOMING selected connector (indegree 0); every root and its
 * connector-descendants emit depth-first, siblings ordered by visual position (y then x)
 * so the text reads top-to-bottom exactly as the map looks. Reads connectors from the
 * WHOLE board but keeps only edges whose BOTH endpoints are selected (mirrors
 * `arrangeMindMap`). Cycle/DAG-safe: a node emits once (first visit wins). Returns [] when
 * there is nothing to walk. Pure — no I/O, deterministic.
 */
export function mindMapOutline(
  items: readonly BoardItem[],
  memberIds: readonly string[],
): OutlineLine[] {
  const want = new Set(memberIds);
  const nodes = items.filter((i) => want.has(i.memberId) && !itemIsConnector(i));
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((n) => [n.memberId, n]));
  const children = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    children.set(n.memberId, []);
    indeg.set(n.memberId, 0);
  }
  for (const it of items) {
    if (!itemIsConnector(it)) continue;
    const from = it.extra?.fromMemberId;
    const to = it.extra?.toMemberId;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (!byId.has(from) || !byId.has(to) || from === to) continue;
    children.get(from)!.push(to);
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
  }
  // Visual order: top-to-bottom, then left-to-right. Applied to roots and every sibling set.
  const byPosition = (a: string, b: string): number => {
    const A = byId.get(a)!;
    const B = byId.get(b)!;
    return A.y - B.y || A.x - B.x;
  };
  for (const kids of children.values()) kids.sort(byPosition);
  const roots = nodes
    .filter((n) => (indeg.get(n.memberId) ?? 0) === 0)
    .map((n) => n.memberId)
    .sort(byPosition);
  // A DAG with no indegree-0 node (every node in a cycle) still deserves an outline —
  // fall back to the first node by position so nothing is silently dropped.
  const starts = roots.length > 0 ? roots : [[...byId.keys()].sort(byPosition)[0]];
  // ITERATIVE pre-order DFS (an explicit stack, NOT recursion) so a deep connector chain (a 20k-node
  // n0→n1→…→n19999 line, all selected) cannot overflow the call stack — a real DoS on "copy as outline".
  // `emitted` is a global emit-once guard: because a node is marked emitted BEFORE its children are
  // pushed, any ancestor on the current chain is already emitted, so the emitted check alone breaks
  // cycles AND dedups shared DAG nodes (each emits once under its first-reached parent) — the separate
  // onPath set the recursion used was redundant. Children are pushed in REVERSE so the first (top-most)
  // child pops first, preserving the visual sorted order. Each start's whole subtree emits before the
  // next start, matching the old `for (const r of starts) walk(r, 0)`.
  const out: OutlineLine[] = [];
  const emitted = new Set<string>();
  for (const start of starts) {
    if (emitted.has(start)) continue;
    const stack: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];
    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      if (emitted.has(id)) continue; // shared node (DAG) / cycle back-edge — emit once
      emitted.add(id);
      out.push({ depth, text: outlineText(byId.get(id)!), memberId: id });
      const kids = children.get(id)!;
      for (let k = kids.length - 1; k >= 0; k -= 1) {
        if (!emitted.has(kids[k])) stack.push({ id: kids[k], depth: depth + 1 });
      }
    }
  }
  return out;
}

/** Render outline lines as a Markdown bullet list (two spaces per depth). */
export function outlineToMarkdown(lines: readonly OutlineLine[]): string {
  return lines.map((l) => `${'  '.repeat(l.depth)}- ${l.text}`).join('\n');
}

// ── OUTLINE IMPORT — the inverse of #184: indented text → a tidy mind-map. ──
//
// Round-trips the OutlineLine model. `parseOutline` recovers depth from indentation
// (an indent-width stack, so mixed tab/space or any consistent step works) and strips a
// leading bullet marker; `outlineParents` links each line to its nearest shallower
// ancestor; `planOutlineMindMap` composes those with the SAME `computeTreeLayout` the
// live arrange uses, emitting LOCAL positions + index edges the caller mints into nodes
// + connectors. Pure — the panel owns the actual `placeItem` minting (like connectSelected).

/** Layout box for an imported node (fixed so `computeTreeLayout` spaces siblings evenly). */
const OUTLINE_NODE_W = 200;
const OUTLINE_NODE_H = 90;

/**
 * Parse indented text into ordered outline lines. Depth comes from leading-whitespace
 * width via a stack (deeper indent → push a level, shallower → pop), so it round-trips
 * `outlineToMarkdown` ("  - Child" → depth 1 "Child") and tolerates tabs or any step.
 * A leading bullet marker (-, *, +, •) is stripped from the text but never affects depth.
 * Blank lines are skipped. Pure.
 */
export function parseOutline(text: string): OutlineLine[] {
  const out: OutlineLine[] = [];
  const stack: number[] = []; // indent width at each open depth
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue;
    const indent = raw.length - raw.replace(/^[ \t]+/, '').length;
    const body = raw.slice(indent).replace(/^[-*+•]\s+/, '').trim();
    if (body.length === 0) continue;
    while (stack.length > 0 && indent < stack[stack.length - 1]) stack.pop();
    if (stack.length === 0 || indent > stack[stack.length - 1]) stack.push(indent);
    out.push({ depth: stack.length - 1, text: body });
  }
  return out;
}

/**
 * For each line, the index of its parent (the nearest EARLIER line with a smaller depth),
 * or -1 for a root. Pure — a stack of the last-seen line index at each depth.
 */
export function outlineParents(lines: readonly OutlineLine[]): number[] {
  const parents: number[] = [];
  const lastAtDepth: number[] = []; // lastAtDepth[d] = index of the most recent line at depth d
  lines.forEach((line, i) => {
    parents.push(line.depth === 0 ? -1 : lastAtDepth[line.depth - 1] ?? -1);
    lastAtDepth[line.depth] = i;
    lastAtDepth.length = line.depth + 1; // deeper levels are stale once we ascend
  });
  return parents;
}

/** An imported node: its text + LOCAL top-left (anchored at 0,0, caller adds an origin). */
export interface OutlinePlanNode {
  readonly depth: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Plan a mind-map from an outline: parse → parent-link → tidy-layout. Returns each node
 * with a LOCAL position and index-pair edges (parent→child). The caller mints one node
 * per plan node (at origin + x/y) and one connector per edge. When the tidy layout yields
 * nothing (a flat list with no parent/child links), nodes stack in a single column so a
 * flat paste still lands as a readable list. Pure.
 */
export function planOutlineMindMap(
  text: string,
  opts: TreeLayoutOptions = {},
): { nodes: OutlinePlanNode[]; edges: { from: number; to: number }[] } {
  const lines = parseOutline(text);
  if (lines.length === 0) return { nodes: [], edges: [] };
  const parents = outlineParents(lines);
  const layoutNodes: LayoutNode[] = lines.map((_, i) => ({
    memberId: String(i),
    w: OUTLINE_NODE_W,
    h: OUTLINE_NODE_H,
  }));
  const edges: { from: number; to: number }[] = [];
  lines.forEach((_, i) => {
    if (parents[i] >= 0) edges.push({ from: parents[i], to: i });
  });
  const local = computeTreeLayout(
    layoutNodes,
    edges.map((e) => ({ from: String(e.from), to: String(e.to) })),
    opts,
  );
  const nodes: OutlinePlanNode[] = lines.map((l, i) => {
    const p = local.get(String(i));
    return {
      depth: l.depth,
      text: l.text,
      x: p?.x ?? 0,
      y: p?.y ?? i * (OUTLINE_NODE_H + 40), // no tree → stack vertically
    };
  });
  return { nodes, edges };
}

// ── MIND-MAP BRANCH COLLAPSE — hide/show a node's whole connector-subtree. ──
//
// The third leg of the mind-map triad (#159 build → #161 tidy → #162 focus): collapse
// a branch to declutter a dense map. Pure composition — it computes the descendant set
// from the SAME connector adjacency `computeTreeLayout` reads, then flips them through
// the EXISTING #149 visibility primitive (`setHidden`). No new hide mechanism, no new
// representation: hidden items are already removed from the canvas, connectors to a
// hidden endpoint are already auto-suppressed, and #150's reveal toggle already un-hides.

/**
 * The ONE connector-graph BFS (both directions share this body, L100). Reaches every node
 * from `rootId`, EXCLUDING the root; cycle-safe (visited set). `forward` picks the edge
 * direction: true = from→to (descendants), false = to→from (ancestors). `edgeAllowed` scopes
 * the walk to a subset of edges (e.g. one relationship kind). Deterministic (insertion order).
 */
function reachViaConnectors(
  items: readonly BoardItem[],
  rootId: string,
  forward: boolean,
  edgeAllowed: (connector: BoardItem) => boolean = () => true,
): string[] {
  // Only REAL members are reachable targets. A DANGLING connector endpoint (a from/toMemberId with no
  // matching item — reachable from an imported/persisted graph, where a connector can outlive the node
  // it pointed at) must NOT enter the traversal: it would be returned as a phantom id, and a downstream
  // patch (setBranchHidden → setHidden → setMemberFields) THROWS `no member` on a non-existent member —
  // a one-click collapse/expand crash. Filtering edges to real member ids here fixes that for EVERY
  // consumer (descendants/ancestors/branch/upstream/branch-colours) at the root (L063 category fix).
  const realIds = new Set(items.map((i) => i.memberId));
  const adj = new Map<string, string[]>();
  for (const it of items) {
    if (!itemIsConnector(it)) continue;
    if (!edgeAllowed(it)) continue; // scope the traversal to a subset of edges (e.g. one relationship kind)
    const from = it.extra?.fromMemberId;
    const to = it.extra?.toMemberId;
    if (typeof from === 'string' && typeof to === 'string' && realIds.has(from) && realIds.has(to)) {
      const key = forward ? from : to; // walk from→to (descendants) or to→from (ancestors)
      const val = forward ? to : from;
      const kids = adj.get(key);
      if (kids) kids.push(val);
      else adj.set(key, [val]);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  // Explicit HEAD-INDEX queue — `Array.shift()` reindexes the whole array on every pop (O(n) each), so a
  // wide graph (one root with 100k connector children) made this BFS O(n²) and hung the UI. Advancing a
  // read cursor keeps it O(V+E).
  const queue = [...(adj.get(rootId) ?? [])];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const next of adj.get(id) ?? []) if (!seen.has(next)) queue.push(next);
  }
  return out;
}

/**
 * Every node reachable from `rootId` by FOLLOWING connector edges (from→to), EXCLUDING
 * the root itself. The descendant subtree a collapse hides / an expand restores.
 */
export function descendantsViaConnectors(
  items: readonly BoardItem[],
  rootId: string,
  edgeAllowed?: (connector: BoardItem) => boolean,
): string[] {
  return reachViaConnectors(items, rootId, true, edgeAllowed);
}

/**
 * Every node reachable from `rootId` by walking connector edges BACKWARD (to→from) — the
 * transitive ANCESTORS ("everything that flows INTO this node"), EXCLUDING the root itself.
 * The upstream mirror of {@link descendantsViaConnectors} over the same BFS body.
 */
export function ancestorsViaConnectors(
  items: readonly BoardItem[],
  rootId: string,
  edgeAllowed?: (connector: BoardItem) => boolean,
): string[] {
  return reachViaConnectors(items, rootId, false, edgeAllowed);
}

/**
 * The whole branch rooted at `rootId`: the root itself PLUS every connector-descendant
 * (#186 "select branch" — MindNode/XMind canon). Pure — composes `descendantsViaConnectors`
 * so the select-branch selection matches exactly what a collapse would hide. The root leads
 * so callers can treat element 0 as the anchor.
 */
export function branchMemberIds(
  items: readonly BoardItem[],
  rootId: string,
  edgeAllowed?: (connector: BoardItem) => boolean,
): string[] {
  return [rootId, ...descendantsViaConnectors(items, rootId, edgeAllowed)];
}

/**
 * The UPSTREAM lineage of `rootId`: the root itself PLUS every transitive ancestor (walking
 * connectors backward). The mirror of {@link branchMemberIds} — "select everything that leads
 * INTO this node". The root leads so callers can treat element 0 as the anchor.
 */
export function upstreamMemberIds(
  items: readonly BoardItem[],
  rootId: string,
  edgeAllowed?: (connector: BoardItem) => boolean,
): string[] {
  return [rootId, ...ancestorsViaConnectors(items, rootId, edgeAllowed)];
}

/**
 * Every non-root mind-map node — a non-connector node with ≥1 INCOMING connector (indegree
 * ≥ 1). Hiding this whole set is "Fold all" (#191): only the roots (indegree 0) stay visible,
 * collapsing every branch on the board at once. Pure — the board-wide sibling of #162's
 * per-branch descendant set, computed straight from the connector adjacency.
 */
export function mindMapNonRootIds(items: readonly BoardItem[]): string[] {
  const nodeIds = new Set(items.filter((i) => !itemIsConnector(i)).map((i) => i.memberId));
  const hasIncoming = new Set<string>();
  for (const it of items) {
    if (!itemIsConnector(it)) continue;
    const to = it.extra?.toMemberId;
    if (typeof to === 'string' && nodeIds.has(to)) hasIncoming.add(to);
  }
  return [...hasIncoming];
}

/**
 * The PARENT of `memberId` in the connector graph: the `from` endpoint of the first
 * connector whose `to === memberId`. Shape-based (`itemIsConnector`), never a kind
 * literal. `undefined` when the node is a root (no inbound connector) — used by Enter
 * (add-sibling) to find the node to attach the new sibling under. First-parent on a DAG.
 */
export function parentViaConnectors(items: readonly BoardItem[], memberId: string): string | undefined {
  for (const it of items) {
    if (!itemIsConnector(it)) continue;
    // Skip a SELF-LOOP (from === to): a connector A→A would otherwise report A as its OWN parent,
    // corrupting add-sibling/tree semantics for a caller. A node is its own parent under no topology.
    if (it.extra?.toMemberId === memberId && typeof it.extra?.fromMemberId === 'string' && it.extra.fromMemberId !== memberId) {
      return it.extra.fromMemberId;
    }
  }
  return undefined;
}

/**
 * Count of DIRECT connector-children of `memberId` (connectors with `from === memberId`).
 * Used by Tab (add-child) to stack each new child below the previous one instead of
 * overlapping. Direct only — not the transitive descendant count.
 */
export function directChildCount(items: readonly BoardItem[], memberId: string): number {
  let n = 0;
  for (const it of items) {
    if (itemIsConnector(it) && it.extra?.fromMemberId === memberId) n += 1;
  }
  return n;
}

/**
 * #165 — assign each TOP-LEVEL branch of every mind-map tree a distinct palette colour
 * (MindNode "colorful branches" / XMind rainbow). A ROOT is a node with NO inbound
 * connector that HAS ≥1 connector-child; each of its direct children starts a branch;
 * branch `i` takes `palette[i % palette.length]`, and that colour flows to the branch
 * child + every `descendantsViaConnectors(branchChild)`. Returns `memberId → colour` for
 * NODES only — the root stays neutral (MindNode keeps the central topic distinct).
 * Shape-based via `itemIsConnector`; the palette is INJECTED (L090 — zero hardcoded
 * colours in the engine). Pure + deterministic (stable item order). A forest of roots
 * each restarts the palette so every tree is independently rainbow.
 */
export function branchColorAssignments(
  items: readonly BoardItem[],
  palette: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (palette.length === 0) return out;
  const children = new Map<string, string[]>();
  const hasInbound = new Set<string>();
  for (const it of items) {
    if (!itemIsConnector(it)) continue;
    const from = it.extra?.fromMemberId;
    const to = it.extra?.toMemberId;
    if (typeof from === 'string' && typeof to === 'string') {
      const kids = children.get(from);
      if (kids) kids.push(to);
      else children.set(from, [to]);
      hasInbound.add(to);
    }
  }
  for (const it of items) {
    if (itemIsConnector(it)) continue;
    if (hasInbound.has(it.memberId)) continue;        // not a root
    const branches = children.get(it.memberId);
    if (!branches || branches.length === 0) continue; // leaf / childless → not a tree root
    branches.forEach((branchId, i) => {
      const color = palette[i % palette.length];
      out.set(branchId, color);
      for (const desc of descendantsViaConnectors(items, branchId)) out.set(desc, color);
    });
  }
  return out;
}

/**
 * #166 — the connector half of rainbow branches. A connector belongs to the branch of the
 * node it points INTO (`toMemberId`), so its line takes that node's branch colour. Given the
 * #165 `branchColorAssignments` node→colour map, return `connectorMemberId → colour` for
 * every connector whose `to` endpoint is a coloured node. Shape-based via `itemIsConnector`;
 * derives nothing — it just reaches the existing colour through the connector topology, so
 * the whole branch (nodes + the lines linking them) reads as one colour. Pure.
 */
export function connectorBranchColors(
  items: readonly BoardItem[],
  nodeColors: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const it of items) {
    if (!itemIsConnector(it)) continue;
    const to = it.extra?.toMemberId;
    if (typeof to !== 'string') continue;
    const color = nodeColors.get(to);
    if (color) out.set(it.memberId, color);
  }
  return out;
}

/**
 * Collapse (`hidden=true`) or expand (`hidden=false`) the connector-subtree rooted at
 * `rootId` — flips `extra.hidden` on every descendant via the #149 `setHidden` primitive.
 * The root stays visible (it carries the collapsed branch). No-op when the node has no
 * connector-children. Deliberately NOT lock-safe-gated: hiding a branch is a VIEW
 * operation (like #149 hide), so a locked descendant is still collapsible.
 */
export function setBranchHidden(
  graph: GroupGraph,
  parentRef: AddressRef,
  rootId: string,
  hidden: boolean,
): GroupGraph {
  const descendants = descendantsViaConnectors(readItems(graph, parentRef), rootId);
  if (descendants.length === 0) return graph;
  return setHidden(graph, parentRef, descendants, hidden);
}

/** Per-node collapse state for the on-node caret (#163): the toggle state of EVERY node
 *  that has a connector-subtree. `collapsed` = no descendant is visible (the whole branch
 *  is folded → show an expand caret); `hiddenCount` = how many descendants are hidden
 *  (shown on the collapsed caret, FigJam canon). Built ONCE per items/hiddenIds change
 *  (one `descendantsViaConnectors` per node-with-children) so the render is O(1) per node.
 *  A node with zero connector-children is absent from the map → no caret (L118). */
export function branchToggleStates(
  items: readonly BoardItem[],
  hiddenIds: ReadonlySet<string>,
): Map<string, { collapsed: boolean; hiddenCount: number }> {
  const out = new Map<string, { collapsed: boolean; hiddenCount: number }>();
  const parents = new Set<string>();
  for (const it of items) if (itemIsConnector(it) && typeof it.extra?.fromMemberId === 'string') parents.add(it.extra.fromMemberId);
  for (const rootId of parents) {
    const descendants = descendantsViaConnectors(items, rootId);
    if (descendants.length === 0) continue;
    let anyVisible = false;
    let hiddenCount = 0;
    for (const d of descendants) {
      if (hiddenIds.has(d)) hiddenCount += 1;
      else anyVisible = true;
    }
    out.set(rootId, { collapsed: !anyVisible, hiddenCount });
  }
  return out;
}

// ── EQUAL SIZE — match every box's width/height to a reference (primary or max). ──

export function equalSize(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  dim: 'w' | 'h' | 'both',
  referenceMemberId: string | null,
): GroupGraph {
  const boxes = boxesFor(graph, parentRef, memberIds);
  if (boxes.length < 2) return graph;
  const ref = boxes.find((b) => b.memberId === referenceMemberId) ?? boxes[0];
  const patches = boxes.map((b) => {
    const patch: Record<string, unknown> = {};
    if (dim === 'w' || dim === 'both') patch.w = ref.w;
    if (dim === 'h' || dim === 'both') patch.h = ref.h;
    return { memberId: b.memberId, patch };
  });
  return patchEach(graph, parentRef, patches);
}

// ── FRAME ASPECT — reshape every selected PRESENTATION FRAME into a slide/print box. ──

/**
 * Reshape every selected PRESENTATION FRAME (#177) to the given `w:h` ratio, preserving
 * each frame's top-left + width (`resizeToAspect`). NON-frame members in the set are
 * untouched — only a frame becomes a slide, so a mixed selection (a frame + its contents)
 * reshapes just the frame. Pure graph→graph, folding the one generic `patchItem` mutation
 * (via `patchEach`) exactly like `equalSize`, so the board wraps it in ONE undo checkpoint.
 * The RATIO is DATA (`FRAME_ASPECTS`); this function never enumerates a ratio.
 */
export function reshapeFramesToAspect(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  ratioW: number,
  ratioH: number,
): GroupGraph {
  const want = new Set(memberIds);
  const patches = readItems(graph, parentRef)
    .filter((i) => want.has(i.memberId) && presentationFrameOf(i) !== null)
    .map((i) => ({ memberId: i.memberId, patch: resizeToAspect(i, ratioW, ratioH) as Record<string, unknown> }));
  return patchEach(graph, parentRef, patches);
}

// ── REVERSE CONNECTOR — swap a connector's from/to endpoints (flip the arrowhead). ──

/**
 * Reverse the DIRECTION of every selected CONNECTOR (#180) by swapping its `from/to`
 * endpoint ids, flipping the arrowhead so a relationship drawn backwards is fixed in one
 * click. NON-connector members in the set are untouched. Pure graph→graph, folding the one
 * generic `patchItem` mutation (via `patchEach`), so the board wraps it in ONE undo step.
 * Shape-based (`itemIsConnector`), never a `kind === 'connector'` literal (L090).
 */
export function reverseConnectors(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
): GroupGraph {
  const want = new Set(memberIds);
  const patches = readItems(graph, parentRef)
    .filter((i) => want.has(i.memberId) && itemIsConnector(i))
    .map((i) => ({
      memberId: i.memberId,
      // itemIsConnector guarantees both are strings; swap them.
      patch: {
        fromMemberId: i.extra?.toMemberId,
        toMemberId: i.extra?.fromMemberId,
      } as Record<string, unknown>,
    }));
  return patchEach(graph, parentRef, patches);
}

// ── CONNECT SELECTED — wire an ordered node selection into a connector chain. ──

/** Unordered endpoint key for two member ids — so an a→b connector and a b→a connector
 *  count as the SAME link (no duplicate arrows regardless of direction). */
export function connectorPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The node ids NOT in the current selection (#183 — Select Inverse: "select everything
 *  except these"). Pure set complement over the selectable node ids. */
export function invertedNodeIds(nodeIds: readonly string[], selected: ReadonlySet<string>): string[] {
  return nodeIds.filter((id) => !selected.has(id));
}

/** One from→to link to mint. */
export interface ConnectorPair {
  readonly from: string;
  readonly to: string;
}

/**
 * A connector TOPOLOGY (#182): given the spatially-ordered selected node ids and the set of
 * {@link connectorPairKey}s already linked, decide exactly which new links to mint. This is
 * the generative seam — "connect the selection" is ONE board mechanism (sort + dedup + mint
 * + commit); each topology (chain, star, …) is a pure function of this shape, so adding a
 * topology is one generator + one DATA row, ZERO board change (L069). Never enumerated in
 * the board — the row carries its generator.
 */
export type ConnectorTopology = (orderedIds: readonly string[], existing: ReadonlySet<string>) => ConnectorPair[];

/**
 * CHAIN topology (#181): consecutive from→to pairs [a→b, b→c, …] MINUS any pair already
 * linked in either direction (repeat invocations never stack duplicate arrows). Fewer than
 * 2 ids → no pairs. Pure.
 */
export const newChainConnectors: ConnectorTopology = (nodeIds, existing) => {
  const out: ConnectorPair[] = [];
  for (let i = 0; i + 1 < nodeIds.length; i += 1) {
    const from = nodeIds[i];
    const to = nodeIds[i + 1];
    if (!existing.has(connectorPairKey(from, to))) out.push({ from, to });
  }
  return out;
};

/**
 * STAR / hub topology (#182): the FIRST (leftmost) node is the hub; link hub→each other
 * node, skipping any pair already linked in either direction. This is the canonical
 * mind-map shape (central idea → spokes). Fewer than 2 ids → no pairs. Pure.
 */
export const newStarConnectors: ConnectorTopology = (nodeIds, existing) => {
  if (nodeIds.length < 2) return [];
  const hub = nodeIds[0];
  const out: ConnectorPair[] = [];
  for (let i = 1; i < nodeIds.length; i += 1) {
    const to = nodeIds[i];
    if (!existing.has(connectorPairKey(hub, to))) out.push({ from: hub, to });
  }
  return out;
};

/**
 * CYCLE / loop topology (cont.20): the chain a→b→c… PLUS a closing edge last→first, so the
 * selection becomes a closed loop (a process cycle / feedback ring). A pure emergent generator
 * over the SAME ConnectorTopology seam — the L069 proof the primitive predicted: a new topology
 * is one generator + one DATA row, ZERO board/panel change. Dedups within the call too (an
 * n=2 loop's closing b→a is the SAME undirected pair as a→b → collapses to one edge). <2 ids →
 * none. Pure.
 */
export const newCycleConnectors: ConnectorTopology = (nodeIds, existing) => {
  if (nodeIds.length < 2) return [];
  const seen = new Set(existing);
  const out: ConnectorPair[] = [];
  const add = (from: string, to: string) => {
    const key = connectorPairKey(from, to);
    if (from !== to && !seen.has(key)) {
      seen.add(key);
      out.push({ from, to });
    }
  };
  for (let i = 0; i + 1 < nodeIds.length; i += 1) add(nodeIds[i], nodeIds[i + 1]);
  add(nodeIds[nodeIds.length - 1], nodeIds[0]); // close the loop
  return out;
};

/** The largest selection {@link newMeshConnectors} will fully connect (O(n²) edges → an OOM guard). A
 *  complete mesh of >500 nodes is ~125k+ edges and an unreadable hairball — never a real user intent. */
const MAX_MESH_NODES = 500;

/**
 * MESH / complete-graph topology (cont.20): EVERY unordered pair linked (a fully-connected
 * relationship web — "everything relates to everything", the affinity/cluster shape). i<j so
 * each pair is minted once; the undirected `connectorPairKey` skips any pair already linked
 * (idempotent re-run). Another pure emergent generator over the ONE seam, ZERO board change.
 * <2 ids → none. O(n²) edges by definition, so the leaf SELF-GATES on {@link MAX_MESH_NODES} — the
 * action-list caller only gates on "≥2 selected", so without this guard a select-all on a big imported
 * board (+ "Connect all to all") would mint ~n²/2 pairs and exhaust memory. Fail closed. Pure.
 */
export const newMeshConnectors: ConnectorTopology = (nodeIds, existing) => {
  if (nodeIds.length > MAX_MESH_NODES) return []; // O(n²) DoS guard — a full mesh of hundreds is already an unreadable hairball
  const seen = new Set(existing);
  const out: ConnectorPair[] = [];
  for (let i = 0; i < nodeIds.length; i += 1) {
    for (let j = i + 1; j < nodeIds.length; j += 1) {
      const key = connectorPairKey(nodeIds[i], nodeIds[j]);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ from: nodeIds[i], to: nodeIds[j] });
      }
    }
  }
  return out;
};

// ── APPLY BUNDLE — stamp ONE visual-layer stack onto every selected item. ──

export function applyBundleToAll(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  bundle: VisualLayerStackRecord,
): GroupGraph {
  // Re-home each layer stack's region to the item it lands on so layers resolve
  // against the right node, while keeping the layer/clip/frame DATA intact.
  const patches = memberIds.map((memberId) => ({
    memberId,
    patch: { visualLayerStack: { ...bundle, region: parentRef } satisfies VisualLayerStackRecord },
  }));
  return patchEach(graph, parentRef, patches);
}

// ── Z-ORDER — member array position IS paint order (last = front). ──

/** Move the selected members to the front (end of the order) or back (start),
 *  preserving their relative order among themselves. */
export function reorderZ(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  edge: 'front' | 'back',
): GroupGraph {
  if (memberIds.length === 0) return graph;
  // Walk the selected members in current paint order so their relative order is
  // preserved. 'front' sends them to the tail (last = on top), 'back' to the head.
  // Build the whole target order in ONE pass and apply it once via setMemberOrder
  // (O(M+K)) instead of folding reorderMember per id (O(K*M) = O(N^2) on select-all).
  const order = readItems(graph, parentRef).map((i) => i.memberId);
  const selectedSet = new Set(memberIds);
  const selectedInOrder = order.filter((id) => selectedSet.has(id));
  const rest = order.filter((id) => !selectedSet.has(id));
  const target = edge === 'front' ? [...rest, ...selectedInOrder] : [...selectedInOrder, ...rest];
  return setMemberOrder(graph, parentRef, target);
}

/** Move the selected members ONE step toward the front (later in order) or back
 *  (earlier), swapping past adjacent NON-selected neighbours only — a selected block
 *  moves together and selected items never jump past each other (PowerPoint / FigJam
 *  "bring forward" / "send backward"). Reuses `reorderMember`'s before/after placement;
 *  only the items that change position are written. The ±1 case of `reorderZ`'s ±∞. */
export function reorderZStep(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  dir: 'forward' | 'backward',
): GroupGraph {
  if (memberIds.length === 0) return graph;
  const order = readItems(graph, parentRef).map((i) => i.memberId);
  const sel = new Set(memberIds);
  let next = graph;
  if (dir === 'forward') {
    // Top-to-bottom so each selected item hops up at most once (past the non-selected
    // neighbour directly above it); a selected neighbour above blocks the move.
    for (let i = order.length - 1; i >= 0; i--) {
      if (sel.has(order[i]) && i + 1 < order.length && !sel.has(order[i + 1])) {
        next = reorderMember(next, parentRef, order[i], { after: order[i + 1] });
        [order[i], order[i + 1]] = [order[i + 1], order[i]];
      }
    }
  } else {
    for (let i = 0; i < order.length; i++) {
      if (sel.has(order[i]) && i - 1 >= 0 && !sel.has(order[i - 1])) {
        next = reorderMember(next, parentRef, order[i], { before: order[i - 1] });
        [order[i - 1], order[i]] = [order[i], order[i - 1]];
      }
    }
  }
  return next;
}

/** Restack the board to an EXACT member order (#152 — the Objects-panel drag-reorder).
 *  `order` is BOTTOM→TOP memberOrder. Reuses `reorderMember`'s `{after}` placement:
 *  sequencing each member after its predecessor builds the full target order, so no
 *  new "move-to-index" engine op is needed (L100 — composition over new primitives).
 *  Each member is placed after its predecessor unconditionally; structural sharing
 *  keeps an already-correct (or single-element) order a functional no-op. */
export function reorderZToOrder(
  graph: GroupGraph,
  parentRef: AddressRef,
  order: readonly string[],
): GroupGraph {
  // The Objects-panel passes the group's FULL sibling set in the new top→bottom
  // order (a permutation), so setting memberOrder to it in ONE pass is exact —
  // and O(M) instead of the old per-id reorderMember fold (O(M^2) on a big board).
  return setMemberOrder(graph, parentRef, order);
}

// ── FLIP — mirror the selection about its vertical (x) or horizontal (y) axis. ──

/**
 * Flip the selected items about the selection's bounding-box centre axis. For a
 * SINGLE item the pivot is its own centre, so the item mirrors in place; for a
 * GROUP the whole arrangement mirrors (each item's centre reflects across the
 * pivot). ONE rule covers both (L069) — single is the degenerate group.
 *
 * The correct axis-mirror of a (possibly rotated, possibly already-flipped) item:
 * mirroring `R(θ)·S(sx,sy)` by `M_x = diag(-1,1)` gives `R(-θ)·S(-sx, sy)` because
 * `M_x·R(θ) = R(-θ)·M_x`. So per item a horizontal flip is exactly: rotation → -θ
 * (normalized), flipX → !flipX (toggle), centre's x → mirrored about pivotX; w/h and
 * the other axis untouched. Vertical flip is the Y-symmetric. Applying the same flip
 * twice is the identity (involution) — verified by unit tests.
 */
export function flipItems(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  axis: 'x' | 'y',
): GroupGraph {
  const want = new Set(memberIds);
  const items = readFiniteItems(graph, parentRef).filter((i) => want.has(i.memberId)); // sanitize coords → pivot can't overflow
  if (items.length === 0) return graph;
  const minX = minOf(items.map((i) => i.x));
  const maxX = maxOf(items.map((i) => i.x + i.w));
  const minY = minOf(items.map((i) => i.y));
  const maxY = maxOf(items.map((i) => i.y + i.h));
  const pivotX = (minX + maxX) / 2;
  const pivotY = (minY + maxY) / 2;
  const patches = items.map((i) => {
    const cx = i.x + i.w / 2;
    const cy = i.y + i.h / 2;
    const rot = Number(i.extra?.rotation) || 0;
    const negRot = ((-rot % 360) + 360) % 360;
    if (axis === 'x') {
      const cx2 = 2 * pivotX - cx;
      return { memberId: i.memberId, patch: { x: Math.round(cx2 - i.w / 2), rotation: negRot, flipX: i.extra?.flipX !== true } };
    }
    const cy2 = 2 * pivotY - cy;
    return { memberId: i.memberId, patch: { y: Math.round(cy2 - i.h / 2), rotation: negRot, flipY: i.extra?.flipY !== true } };
  });
  return patchEach(graph, parentRef, patches);
}

/**
 * Rotate the selection by `degrees` about its bounding-box centre (the rows below
 * call ±90 for the quarter-turn). Each item's centre ORBITS the pivot and its own
 * `extra.rotation` advances by `degrees` (normalized 0..360); w/h are unchanged.
 * A single item orbits about itself → it rotates in place. The exact inverse of
 * itself at `-degrees` (and 4× +90 returns to the start, modulo rounding). This is
 * the rotation analogue of {@link flipItems} — same bbox-pivot + per-item-patch shape,
 * reusing the same orbit math the live group-rotation drag (#113) applies.
 */
export function rotateItems(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  degrees: number,
): GroupGraph {
  const want = new Set(memberIds);
  const items = readFiniteItems(graph, parentRef).filter((i) => want.has(i.memberId)); // sanitize coords → pivot can't overflow
  if (items.length === 0) return graph;
  const pivotX = (minOf(items.map((i) => i.x)) + maxOf(items.map((i) => i.x + i.w))) / 2;
  const pivotY = (minOf(items.map((i) => i.y)) + maxOf(items.map((i) => i.y + i.h))) / 2;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const patches = items.map((i) => {
    const dx = i.x + i.w / 2 - pivotX;
    const dy = i.y + i.h / 2 - pivotY;
    const ox = pivotX + dx * cos - dy * sin;
    const oy = pivotY + dx * sin + dy * cos;
    const rot = ((((Number(i.extra?.rotation) || 0) + degrees) % 360) + 360) % 360;
    return { memberId: i.memberId, patch: { x: Math.round(ox - i.w / 2), y: Math.round(oy - i.h / 2), rotation: rot } };
  });
  return patchEach(graph, parentRef, patches);
}

// ── LOCK — a locked item ignores drag/resize until unlocked (presentation flag). ──

export function setLocked(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  locked: boolean,
): GroupGraph {
  return patchEach(graph, parentRef, memberIds.map((memberId) => ({ memberId, patch: { locked } })));
}

// ── VISIBILITY — a hidden item is removed from the visible map (reversible view flag). ──
// Sibling of `setLocked`: one self-describing DATA flag on `extra`. Hiding is NOT a
// geometry/content mutation (unlike align/resize/move), so it is deliberately NOT routed
// through the lock chokepoint — a locked item can still be hidden and un-hidden.

export function setHidden(
  graph: GroupGraph,
  parentRef: AddressRef,
  memberIds: readonly string[],
  hidden: boolean,
): GroupGraph {
  return patchEach(graph, parentRef, memberIds.map((memberId) => ({ memberId, patch: { hidden } })));
}

// ── BUNDLE PORT — read/write the opaque attribute bundle of one item (P3 boundary). ──

export interface BundlePort {
  /** The item's current visual-layer stack, or null when it has none. */
  getBundle(memberId: string): VisualLayerStackRecord | null;
}

/** Read the stack off an item from the live items snapshot (board supplies the lookup). */
export function makeBundlePort(getStack: (memberId: string) => VisualLayerStackRecord | null): BundlePort {
  return { getBundle: getStack };
}

// =============================================================================
// PACK BUILDER — wires the pure helpers into the data-described capability rows.
// =============================================================================

export interface BoardBatchContext {
  /** Run a pure graph transform over the selected memberIds as ONE undoable batch. */
  applyBatch(produce: (graph: GroupGraph, memberIds: string[], parentRef: AddressRef) => GroupGraph): void;
  /** The opaque bundle of the primary (anchor) item, for copy/apply-to-all. */
  primaryBundle(): VisualLayerStackRecord | null;
  /** Duplicate every selected item (board owns id minting + placement offset). */
  duplicateSelected(memberIds: string[]): void;
  /** Remove every selected item. */
  deleteSelected(memberIds: string[]): void;
  /** Wrap the selected items into a nested section (board owns section creation). */
  groupSelected(memberIds: string[]): void;
  /** Merge the selected cards into ONE (b132) — fold duplicates/near-duplicates into a single card,
   *  re-anchoring every connector onto the survivor (board owns the plan + graph mutation). */
  mergeSelected(memberIds: string[]): void;
  /** Split the single selected card into one card per line (b132's inverse — b133). Board owns the
   *  plan + fresh-id mint + placement; a no-op unless the card has 2+ segments. */
  splitAnchor(memberIds: string[]): void;
  /** Add tags to every selected item at once (board owns the one tag prompt + merge). */
  tagSelected(memberIds: string[]): void;
  /** Bound the selection in a new presentation FRAME (#169) — the board owns the id mint,
   *  the title prompt, and the `nextFrameOrder`; this is the create half of the story path. */
  createFrameFromSelection(memberIds: string[]): void;
  /** Distribute the selection by a user-typed exact gap (board owns the prompt + axis). */
  spaceByGap(): void;
  /** Expand the selection to every item of the anchor's KIND (anchor = last selected). */
  selectSameKind(memberIds: string[]): void;
  /** Expand the selection to every item SHARING A TAG with the anchor. */
  selectSameTag(memberIds: string[]): void;
  /** Expand the selection to every item with the SAME FILL COLOUR as the anchor. */
  selectSameFill(memberIds: string[]): void;
  /** Expand the selection to every item with the SAME per-item MARKER as the anchor. */
  selectSameMarker(memberIds: string[]): void;
  /** Expand the selection to every item with the SAME per-item SHAPE as the anchor. */
  selectSameShape(memberIds: string[]): void;
  /** Replace the selection with every item spatially INSIDE the anchor frame (#170 —
   *  FigJam section-select; the board owns the containment read + selection set). */
  selectFrameContents(memberIds: string[]): void;
  /** Arrange the anchor frame's contents into an even grid inside it (#173 —
   *  FigJam "reorganize section"; the board owns the layout + the moveItem commit). */
  tidyFrameContents(memberIds: string[]): void;
  /** Move the anchor frame EARLIER (`dir=-1`) or LATER (`dir=+1`) in the present
   *  path (#174 — the board owns the reorder + the patchItem commit). */
  reorderFrame(memberIds: string[], dir: -1 | 1): void;
  /** Set/clear the anchor frame's caption / speaker-note (#176 — the board owns the
   *  askText prompt + the patchItem commit; an empty answer clears it). */
  setFrameCaption(memberIds: string[]): void;
  /** Open the frame-aspect picker for the selected frame(s) (#177 — the board owns the
   *  blind picker over the `FRAME_ASPECTS` DATA + the `reshapeFramesToAspect` commit). */
  pickFrameAspect(memberIds: string[]): void;
  /** Resize the anchor frame to snugly bound its current contents (#178 — the board owns
   *  the `frameFitBox` read + the patchItem commit; empty frame → no-op). */
  fitFrameToContents(memberIds: string[]): void;
  /** True when the anchor (last selected) IS a presentation frame (gates the
   *  Select-frame-contents + Tidy-frame-contents rows — only a frame has contents). */
  anchorIsFrame: boolean;
  /** Resize the anchor SECTION (isSection group) to snugly bound its member items (the membership-
   *  container twin of fitFrameToContents; empty section → no-op). */
  fitSectionToContents(memberIds: string[]): void;
  /** True when the anchor IS a section (isSection group) — gates the Fit-section-to-contents row. */
  anchorIsSection: boolean;
  /** True when the anchor frame is not FIRST in the present path (gates Move-earlier). */
  anchorFrameCanMoveEarlier: boolean;
  /** True when the anchor frame is not LAST in the present path (gates Move-later). */
  anchorFrameCanMoveLater: boolean;
  /** True when ≥1 connector links two of the selected nodes (gates the Arrange-as-mind-map
   *  row — without a relationship there is no tree to lay out, so the row would be a no-op). */
  selectionHasConnectors: boolean;
  /** True when ≥1 SELECTED member IS a connector (gates the Reverse-direction row — only a
   *  selected connector has a direction to flip). Distinct from `selectionHasConnectors`,
   *  which is about connectors between selected NODES. */
  anyConnectorSelected: boolean;
  /** True when ≥2 SELECTED members are non-connector nodes (gates the Connect row — a chain
   *  needs at least two nodes to link). */
  multipleNodesSelected: boolean;
  /** True when EXACTLY one card is selected and its text has 2+ segments (lines) — gates the
   *  Split-into-cards row so it never shows on a single-line card (L118). */
  anchorIsSplittable: boolean;
  /** True when EXACTLY two non-connector nodes are selected (gates the Trace-path row — a path query
   *  has a single FROM and TO, so it is meaningful only for a 2-card selection). */
  exactlyTwoNodesSelected: boolean;
  /** Select the SHORTEST connector path between the two selected cards (either direction) — the board
   *  builds the relationship graph, runs `pathBetween`, and swaps the selection to the chain (a no-op if
   *  the two are not connected). Transient VIEW state, no commit — the sibling of `selectBranch`. */
  tracePath(memberIds: string[]): void;
  /** True when ≥1 other card `[[links]]` to the anchor (gates the Select-backlinks row — nothing links here
   *  → the row would be a dead no-op, L118). */
  anchorHasBacklinks: boolean;
  /** Select the cards that `[[link]]` to the anchor — its backlinks / "linked mentions" (b139). The board
   *  reads the live card-reference graph and swaps the selection. Transient VIEW state, the wikilink sibling
   *  of `selectBranch` (which follows drawn connectors; this follows TYPED references). */
  selectBacklinks(memberIds: string[]): void;
  /** True when the anchor types ≥1 BROKEN `[[Title]]` (naming no card) — gates the Create-linked-cards row
   *  (nothing to create → the row would be a dead no-op, L118). */
  anchorHasBrokenRefs: boolean;
  /** Create a card for each of the anchor's broken `[[Title]]` references (b140 — the Obsidian red-link →
   *  new note move); the board mints the cards (reusing its multi-place), resolving the dangling links. */
  createMissingCards(memberIds: string[]): void;
  /** True when ≥1 ORPHAN exists — a content card touched by no connector AND no `[[reference]]` (gates the
   *  Select-unconnected row; no orphans → the row would be a dead no-op, L118). */
  boardHasOrphans: boolean;
  /** Replace the selection with every ORPHAN (b141) — the floating cards disconnected from everything in
   *  BOTH relationship layers. Board-global (ignores the current selection, like Select-inverse). */
  selectOrphans(): void;
  /** True when ≥1 card is READY — actionable now, with every prerequisite cleared (b144). Gates the
   *  Select-ready row so it never shows as a dead no-op on a board with no cleared frontier (L118). */
  boardHasReadyCards: boolean;
  /** Replace the selection with the READY frontier (b144) — cards whose dependencies are all done, so they
   *  can be started now. Board-global (ignores the current selection, like Select-orphans). */
  selectReady(): void;
  /** True when ≥1 card has an UNLINKED MENTION — its prose names another card's title without a `[[link]]`
   *  (b146). Gates the Select-unlinked-mentions row so it never shows as a dead no-op (L118). */
  boardHasUnlinkedMentions: boolean;
  /** Replace the selection with every card that has an unlinked mention (b146) — the cards worth linking up.
   *  Board-global (ignores the current selection, like Select-orphans). */
  selectUnlinkedMentions(): void;
  /** True when ≥1 card contains an OPEN QUESTION — an interrogative line in its text (b150). Gates the
   *  Select-questions row so it never shows as a dead no-op (L118). */
  boardHasQuestions: boolean;
  /** Replace the selection with every card that has an open question (b150) — the board's unanswered threads.
   *  Board-global (ignores the current selection, like Select-orphans). */
  selectQuestions(): void;
  /** True when ≥2 cards share a title (b151) — an AMBIGUOUS `[[link]]` target that shadows all but the first.
   *  Gates the Select-duplicate-titles row so it never shows as a dead no-op (L118). */
  boardHasDuplicateTitles: boolean;
  /** Replace the selection with every card in a title collision (b151) — the winner AND the shadowed cards, so
   *  the user can rename/merge to restore reference reachability. Board-global (ignores the current selection). */
  selectDuplicateTitles(): void;
  /** True when the board has a NEAR-DUPLICATE tag group (b152) — distinct spellings of one intent (`to-do` vs
   *  `todo`). Gates the Select-near-duplicate-tags row so it never shows as a dead no-op (L118). */
  boardHasFragmentedTags: boolean;
  /** Replace the selection with every card carrying a fragmented tag (b152) — the cards to re-tag onto one
   *  canonical spelling. Board-global (ignores the current selection, like Select-orphans). */
  selectFragmentedTags(): void;
  /** UNIFY every near-duplicate tag onto its canonical (most-used) spelling in ONE undoable batch (b156) — the
   *  one-click fix that completes b152's detector. Board-global; rewrites every affected card's tags. */
  unifyFragmentedTags(): void;
  /** True when the board holds ≥2 separate connected clusters (b153) — a fragmented map. Gates the
   *  Select-largest-cluster row so it never shows when the board is one connected structure (L118). */
  boardHasMultipleClusters: boolean;
  /** Replace the selection with the LARGEST connected cluster (b153) — the board's main structure, so it can be
   *  isolated from the disconnected side-clusters. Board-global (ignores the current selection). */
  selectLargestCluster(): void;
  /** True when the same relationship is drawn by ≥2 connectors (b154) — accidental double-draws. Gates the
   *  Select-redundant-connectors row so it never shows on a clean connector graph (L118). */
  boardHasDuplicateConnectors: boolean;
  /** Replace the selection with the REDUNDANT connectors (b154) — every duplicate except the one kept per
   *  relationship, so the user can delete them in one go. Board-global (ignores the current selection). */
  selectRedundantConnectors(): void;
  /** True when the board has ≥1 SOURCE — a card nothing points to that points onward (b157, a starting point).
   *  Gates the Select-starting-points row (L118). */
  boardHasSources: boolean;
  /** Replace the selection with the SOURCE cards (b157) — the plan's starting points. Board-global. */
  selectSources(): void;
  /** True when the board has ≥1 SINK — a card that points to nothing but is pointed at (b157, a final outcome).
   *  Gates the Select-final-outcomes row (L118). */
  boardHasSinks: boolean;
  /** Replace the selection with the SINK cards (b157) — the plan's final outcomes. Board-global. */
  selectSinks(): void;
  /** True when the board is PARTLY scheduled — some cards dated, some not (b158). Gates the Select-undated row
   *  so it appears only when there is a scheduling gap to fill (L118). */
  boardHasDateGaps: boolean;
  /** Replace the selection with the UNDATED cards (b158) — the cards still missing a deadline. Board-global. */
  selectUndatedCards(): void;
  /** True when the board has ≥1 RECURRING THEME — a term repeating across ≥2 cards' prose (b159). Gates the
   *  Select-cards-about-the-top-theme row so it appears only when there is a shared theme to select (L118). */
  boardHasThemes: boolean;
  /** Replace the selection with the cards sharing the board's TOP recurring theme (b159). Board-global. */
  selectTopThemeCards(): void;
  /** True when ≥1 card carries an external link (b160). Gates the Select-cards-with-a-link row (L118). */
  boardHasLinks: boolean;
  /** Replace the selection with the cards carrying an external link (b160) — the board's cited sources. Board-global. */
  selectLinkedCards(): void;
  /** True when ≥1 card would meaningfully split into ≥2 cards (b161). Gates the Select-cards-to-split row (L118). */
  boardHasSplitCandidates: boolean;
  /** Replace the selection with the cards worth splitting (b161) — the mini-documents to break up. Board-global. */
  selectSplitCandidates(): void;
  /** True when the board is PARTLY tagged — some cards tagged, some not (b162). Gates the Select-untagged row (L118). */
  boardHasTagGaps: boolean;
  /** Replace the selection with the UNTAGGED cards (b162) — the cards still missing a tag. Board-global. */
  selectUntaggedCards(): void;
  /** True when the board has ≥1 real connector (b163). Gates the Select-main-relationship row (L118). */
  boardHasRelationships: boolean;
  /** Replace the selection with the cards in the board's DOMINANT relationship (b163) — the endpoints of the
   *  most-used connector kind. Board-global. */
  selectMainRelationshipCards(): void;
  /** True when ≥1 content card is flagged by a health signal (b164). Gates the Select-cards-with-issues row (L118). */
  boardHasHealthIssues: boolean;
  /** Replace the selection with the cards flagged by ANY health signal (b164) — everything that needs a fix. Board-global. */
  selectHealthIssueCards(): void;
  /** True when ≥1 content card carries a fill colour (b166) — gates the Select-largest-colour-group row (L118). */
  boardHasColorGroups: boolean;
  /** Replace the selection with the cards in the board's DOMINANT colour family (b166) — the largest legend row,
   *  via the generic facet census over the `colorFamily` extractor. Board-global. */
  selectLargestColorGroup(): void;
  /** True when ≥1 pair of tags co-occurs on the same card (b168) — gates the Select-strongest-tag-pair row (L118). */
  boardHasTagPairs: boolean;
  /** Replace the selection with the cards carrying the board's STRONGEST tag pair (b168) — the two tags that share
   *  the most cards, via the generic co-occurrence reducer over the `itemTags` extractor. Board-global. */
  selectStrongestTagPair(): void;
  /** Per-facet count of DISTINCT values among the SELECTED items (keyed by BOARD_ITEM_FACETS id,
   *  e.g. `tag`, `kindFamily`). Gates the "Color by <facet>" rows — a colour-BY grouping needs ≥2
   *  distinct values or it paints everything one colour (a dead no-op, L118). */
  distinctFacetValues: Readonly<Record<string, number>>;
  /** Wire the selected nodes into connectors using the given TOPOLOGY (#181 chain, #182 star,
   *  …). The board owns the spatial sort, the existing-link dedup, the id mint, and the one
   *  undoable commit; the `topology` (a pure {@link ConnectorTopology}) decides WHICH links. */
  connectSelected(memberIds: string[], topology: ConnectorTopology): void;
  /** True when ≥1 non-connector node is NOT selected (gates the Invert row — with nothing
   *  left to swap to, inverting would just clear the selection, so the row would be a no-op). */
  hasUnselectedNodes: boolean;
  /** Replace the selection with every OTHER node (#183 — Select Inverse). The board owns the
   *  read of all nodes + the complement + the selection swap. */
  invertSelection(memberIds: string[]): void;
  /** True when the anchor (last selected) has ≥1 VISIBLE connector-descendant (gates the
   *  Collapse-branch row — nothing visible to hide → the row would be a no-op). */
  anchorHasVisibleDescendants: boolean;
  /** True when the anchor (last selected) has ≥1 HIDDEN connector-descendant (gates the
   *  Expand-branch row — nothing hidden to restore → the row would be a no-op). */
  anchorHasHiddenDescendants: boolean;
  /** Select the anchor's whole branch (#186 — the node + every connector-descendant). The
   *  board owns the branch read + the selection swap (transient VIEW state, no commit). */
  selectBranch(memberIds: string[]): void;
  /** True when the anchor has ≥1 transitive ANCESTOR (an incoming connector) — gates the
   *  "Select upstream" row (nothing leads into the anchor → the row would be a no-op). */
  anchorHasAncestors: boolean;
  /** Select the anchor's whole UPSTREAM lineage (the node + every transitive ancestor). The
   *  all-connector mirror of `selectBranch`. */
  selectUpstream(memberIds: string[]): void;
  /** True when the anchor (last selected) carries ≥1 tag (gates the same-tag row). */
  anchorHasTags: boolean;
  /** True when the anchor (last selected) has a solid fill colour (gates the same-fill row). */
  anchorHasFill: boolean;
  /** True when the anchor carries a per-item bullet marker (gates the same-marker row, L118). */
  anchorHasMarker: boolean;
  /** True when the anchor carries a per-item shape (gates the same-shape row, L118). */
  anchorHasShape: boolean;
  /** Copy the primary (anchor) item's appearance bundle into the session style clipboard. */
  copyStyle(memberIds: string[]): void;
  /** Stamp the copied style bundle onto every selected item (paste-properties). */
  pasteStyle(): void;
  /** True when a style has been copied this session (gates the Paste-style row). */
  hasStyleClipboard: boolean;
  /** Save the primary's bundle as a named preset (opens the name prompt). */
  savePreset(): void;
  /** Open the preset picker → apply a chosen preset bundle to all selected. */
  openPresetPicker(): void;
  /** True when at least one saved preset exists (gates the apply-preset row). */
  hasPresets: boolean;
  /** True when ≥1 selected item is currently unlocked (gates the Lock row). */
  anyUnlockedSelected: boolean;
  /** True when ≥1 selected item is currently locked (gates the Unlock row). */
  anyLockedSelected: boolean;
  /** True when ≥1 selected item is currently visible (gates the Hide row). */
  anyVisibleSelected: boolean;
  /** True when ≥1 selected item is currently hidden (gates the Show row). */
  anyHiddenSelected: boolean;
  /** True when ≥1 visible non-selected drawable exists (gates the Isolate row — without
   *  one there is nothing to hide, so the row would be a no-op). */
  canIsolate: boolean;
  /** Hide every visible item EXCEPT the given keep set (Figma "Isolate selection"). */
  isolateSelection(keepIds: string[]): void;
  /** Export ONLY the selected items as a downloadable SVG (board owns the serializer). */
  exportSelectionSvg(memberIds: string[]): void;
  /** Export ONLY the selected items as a downloadable PNG. */
  exportSelectionPng(memberIds: string[]): void;
  /** Copy ONLY the selected items to the clipboard as a PNG. */
  copySelectionPng(memberIds: string[]): void;
  /** #165 — colour each top-level branch of the selected mind-map distinctly (board owns
   *  the DATA palette + the fill apply, reusing the #124 fill path). */
  colorBranches(memberIds: string[]): void;
  /** #184 — copy the selected mind-map subtree to the clipboard as a Markdown outline. */
  copyOutline(memberIds: string[]): void;
}

/** An item's dot-vote count as an AXIS value: the total dots on it (via the `board-votes` tally
 *  primitive over `extra.votes`), or null when it has NO votes so unvoted cards park in the no-value
 *  pile instead of stacking at 0 (the same "no value → pile" contract due-date/progress use). Pure
 *  composition of two shipped primitives — the axis engine stays blind (L069/L090). */
function votesAxisValue(item: BoardItem): number | null {
  const n = voteCount(tallyFromRaw(item.extra?.votes));
  return n > 0 ? n : null;
}

/** The board's full BatchActionPack — every multi-edit as a DATA-described row. */
export function buildBoardBatchPack(ctx: BoardBatchContext): BatchActionCapability[] {
  const onlyBoardItems = (refs: readonly NodeRef[]) => membersOfRefs(refs).length > 0;
  const geom = (
    id: string,
    label: string,
    icon: string,
    priority: number,
    minCount: number,
    produce: (g: GroupGraph, ids: string[], p: AddressRef) => GroupGraph,
  ): BatchActionCapability => ({
    id,
    label,
    icon,
    priority,
    minCount,
    accepts: onlyBoardItems,
    // Every geometry/z-order batch op skips LOCKED items — a locked item is frozen
    // in place exactly like under pointer drag/resize and keyboard nudge (#135).
    run: (refs) => ctx.applyBatch((g, _ids, p) => produce(g, unlockedOf(g, membersOfRefs(refs), p), p)),
  });

  return [
    {
      // Expand the selection to every item LIKE the anchor (Figma "Select all with
      // same…"). Selection-changing, not graph-mutating — delegates to the board,
      // which injects the criterion (kind / tag) into the generic `similarIds` engine.
      id: 'select-same-kind',
      label: 'Select all of this kind',
      icon: 'Boxes',
      priority: 5,
      minCount: 1,
      accepts: onlyBoardItems,
      run: (refs) => ctx.selectSameKind(membersOfRefs(refs)),
    },
    {
      // Replace the selection with every OTHER node (#183 — Figma/Illustrator "Select
      // Inverse"; "select everything except these"). Selection-changing; the board owns
      // the complement. Shown only when something is left to swap to (L118).
      id: 'invert-selection',
      label: 'Invert selection',
      icon: 'SquareDashedMousePointer',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.hasUnselectedNodes,
      run: (refs) => ctx.invertSelection(membersOfRefs(refs)),
    },
    {
      // Bound the selection in a named presentation FRAME (#169 — Figma/Miro "frame
      // selection"). Graph-mutating; the board owns the id mint + title prompt + order.
      id: 'create-frame-from-selection',
      label: 'Frame selection',
      icon: 'Frame',
      priority: 5,
      minCount: 1,
      accepts: onlyBoardItems,
      run: (refs) => ctx.createFrameFromSelection(membersOfRefs(refs)),
    },
    {
      // Select everything INSIDE the anchor frame (#170 — FigJam "select section
      // contents"). Selection-changing; the board owns the containment read. Shown
      // only when the anchor is a frame (L118 — a non-frame has no contents).
      id: 'select-frame-contents',
      label: 'Select frame contents',
      icon: 'BoxSelect',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorIsFrame,
      run: (refs) => ctx.selectFrameContents(membersOfRefs(refs)),
    },
    {
      // Arrange everything inside the anchor frame into an even grid (#173 — FigJam
      // "reorganize section"). Graph-mutating; the board owns the layout + commit.
      // Shown only when the anchor is a frame (L118 — a non-frame has no contents).
      id: 'tidy-frame-contents',
      label: 'Tidy frame contents',
      icon: 'LayoutGrid',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorIsFrame,
      run: (refs) => ctx.tidyFrameContents(membersOfRefs(refs)),
    },
    {
      // Move the anchor frame one step EARLIER in the present path (#174). Shown
      // only when the anchor is a frame that isn't already first (L118).
      id: 'frame-move-earlier',
      label: 'Move chapter earlier',
      icon: 'ChevronsLeft',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorFrameCanMoveEarlier,
      run: (refs) => ctx.reorderFrame(membersOfRefs(refs), -1),
    },
    {
      // Move the anchor frame one step LATER in the present path (#174). Shown only
      // when the anchor is a frame that isn't already last (L118).
      id: 'frame-move-later',
      label: 'Move chapter later',
      icon: 'ChevronsRight',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorFrameCanMoveLater,
      run: (refs) => ctx.reorderFrame(membersOfRefs(refs), 1),
    },
    {
      // Add a caption / speaker-note to the anchor frame (#176), shown while
      // presenting. Shown only when the anchor is a frame (L118).
      id: 'set-frame-caption',
      label: 'Frame notes…',
      icon: 'Captions',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorIsFrame,
      run: (refs) => ctx.setFrameCaption(membersOfRefs(refs)),
    },
    {
      // Reshape the frame into a slide/print canvas (#177 — 16:9 / 4:3 / 1:1 / A4).
      // Opens a blind picker over the FRAME_ASPECTS DATA; the board reshapes every
      // selected frame via reshapeFramesToAspect. Shown only when the anchor is a
      // frame (L118 — only a frame is a slide).
      id: 'set-frame-aspect',
      label: 'Reshape as slide…',
      icon: 'RectangleHorizontal',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorIsFrame,
      run: (refs) => ctx.pickFrameAspect(membersOfRefs(refs)),
    },
    {
      // Resize the anchor frame to snugly bound its current contents (#178 — FigJam
      // "resize section to fit"; the companion to Tidy). Shown only when the anchor is
      // a frame (L118 — only a frame has contents to fit).
      id: 'fit-frame-to-contents',
      label: 'Fit frame to contents',
      icon: 'Shrink',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorIsFrame,
      run: (refs) => ctx.fitFrameToContents(membersOfRefs(refs)),
    },
    {
      // Fold a frame shut to just its name, or open it again (a collapsible group): what is inside hides with it.
      // Shown only when the anchor is a frame (L118).
      id: 'fold-frame',
      label: 'Fold or open frame',
      icon: 'FoldVertical',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorIsFrame,
      run: (refs) => ctx.applyBatch((g, _ids, p) => toggleFrameFold(g, p, unlockedOf(g, membersOfRefs(refs), p), FOLDED_FRAME_HEIGHT)),
    },
    {
      // Resize the anchor SECTION to snugly bound its members (the membership-container twin of the
      // frame row above; shown only when the anchor is a section — L118, only a section has members).
      id: 'fit-section-to-contents',
      label: 'Fit section to contents',
      icon: 'Shrink',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorIsSection,
      run: (refs) => ctx.fitSectionToContents(membersOfRefs(refs)),
    },
    {
      // Reverse the direction of the selected connector(s) (#180 — flip the arrowhead so
      // a relationship drawn backwards is fixed in one click). Shown only when a connector
      // is selected (L118). Lock-safe via unlockedOf; non-connectors in the set untouched.
      id: 'reverse-connector',
      label: 'Reverse direction',
      icon: 'ArrowLeftRight',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anyConnectorSelected,
      run: (refs) => ctx.applyBatch((g, _ids, p) => reverseConnectors(g, p, unlockedOf(g, membersOfRefs(refs), p))),
    },
    {
      // Wire the selected nodes into a connector chain (#181 — select N notes, connect
      // them into a flow in one action; mind-map / flowchart accelerator). Shown only
      // when ≥2 nodes are selected (L118). The board owns the spatial order + id mint.
      id: 'connect-selected',
      label: 'Connect in sequence',
      icon: 'Spline',
      priority: 5,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.multipleNodesSelected,
      run: (refs) => ctx.connectSelected(membersOfRefs(refs), newChainConnectors),
    },
    {
      // Connect the selection to a central hub (#182 — star topology; the canonical
      // mind-map shape, central idea → spokes). Same board mechanism as the chain row,
      // a different pure topology (L069). Shown only when ≥2 nodes are selected (L118).
      id: 'connect-hub',
      label: 'Connect to hub',
      icon: 'Share2',
      priority: 5,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.multipleNodesSelected,
      run: (refs) => ctx.connectSelected(membersOfRefs(refs), newStarConnectors),
    },
    {
      // Close the selection into a LOOP (cont.20 — process cycle / feedback ring). Same board
      // mechanism as chain/hub, a new pure topology (L069 emergence — ZERO panel change). ≥2 (L118).
      id: 'connect-cycle',
      label: 'Connect in a loop',
      icon: 'IterationCw',
      priority: 5,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.multipleNodesSelected,
      run: (refs) => ctx.connectSelected(membersOfRefs(refs), newCycleConnectors),
    },
    {
      // Merge the selected cards into ONE (b132) — the ACTION half of the duplicate-detection story
      // (find near-duplicates via content-similar → fold them here). The survivor keeps the joined text
      // and inherits every connector (re-anchored, self-loops/dupes dropped). ≥2 nodes (L118).
      id: 'merge-cards',
      label: 'Merge into one',
      icon: 'Combine',
      priority: 5,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.multipleNodesSelected,
      run: (refs) => ctx.mergeSelected(membersOfRefs(refs)),
    },
    {
      // Split ONE card into one card per line (b133 — the inverse of Merge). Shown only when a single
      // card with 2+ segments is selected (ctx.anchorIsSplittable), so it never appears on a one-line
      // card (L118). The head child inherits the original's connectors.
      id: 'split-card',
      label: 'Split into cards',
      icon: 'Scissors',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorIsSplittable,
      run: (refs) => ctx.splitAnchor(membersOfRefs(refs)),
    },
    {
      // Fully connect the selection — every pair linked (cont.20 — affinity/relationship web).
      // The 4th topology over the ONE seam; O(n²) edges, deduped. ≥2 (L118).
      id: 'connect-mesh',
      label: 'Connect all to all',
      icon: 'Waypoints',
      priority: 5,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.multipleNodesSelected,
      run: (refs) => ctx.connectSelected(membersOfRefs(refs), newMeshConnectors),
    },
    {
      // Trace the shortest connector path between the two selected cards (either direction) and select the
      // chain — "how does A lead to B?" over the relationship graph. Gated to EXACTLY two connected nodes so
      // the FROM/TO is unambiguous (a path query needs a single source + target). Selection-only, no commit.
      id: 'trace-path',
      label: 'Trace path between',
      icon: 'Route',
      priority: 5,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.exactlyTwoNodesSelected && ctx.selectionHasConnectors,
      run: (refs) => ctx.tracePath(membersOfRefs(refs)),
    },
    {
      // Select the cards that [[link]] to the anchor — its backlinks (b139). The wikilink twin of
      // Select-upstream: where that follows drawn connectors, this follows TYPED [[Title]] references.
      // Gated to a card that actually HAS backlinks so the row never shows as a dead no-op (L118).
      id: 'select-backlinks',
      label: 'Select cards linking here',
      icon: 'Link2',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasBacklinks,
      run: (refs) => ctx.selectBacklinks(membersOfRefs(refs)),
    },
    {
      // Create a card for each broken [[Title]] the anchor types (b140 — the Obsidian red-link → new note
      // move). Gated to a card that actually HAS a broken reference so the row never shows as a dead no-op
      // (L118); the created cards resolve the dangling wikilinks (b139 brokenReferencesFrom → new cards).
      id: 'create-linked-cards',
      label: 'Create linked cards',
      icon: 'FilePlus',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasBrokenRefs,
      run: (refs) => ctx.createMissingCards(membersOfRefs(refs)),
    },
    {
      // Select every ORPHAN — content cards touched by no connector AND no [[reference]] (b141), the floating
      // ideas on the board. Board-global (like Select-inverse): the run ignores the current selection and
      // swaps to the orphans. Gated to a board that HAS orphans so the row never shows as a dead no-op (L118).
      id: 'select-orphans',
      label: 'Select unconnected cards',
      icon: 'Unlink',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasOrphans,
      run: () => ctx.selectOrphans(),
    },
    {
      // Select the READY frontier — cards whose every prerequisite is cleared, so they can be started NOW
      // (b144, the GTD "next actions" set). Board-global (like Select-orphans): the run ignores the current
      // selection and swaps to the ready cards. Gated to a board that HAS a ready card so the row is never a
      // dead no-op (L118) — a board with no dependencies, or one entirely blocked, hides it.
      id: 'select-ready',
      label: 'Select ready to start',
      icon: 'CirclePlay',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasReadyCards,
      run: () => ctx.selectReady(),
    },
    {
      // Select every card with an UNLINKED MENTION — its prose names another card's title without a [[link]]
      // (b146, the Obsidian "you mentioned this but didn't link it" move). Board-global (like Select-orphans):
      // ignores the current selection and swaps to the mentioning cards. Gated to a board that HAS one so the
      // row never shows as a dead no-op (L118).
      id: 'select-unlinked-mentions',
      label: 'Select cards with unlinked mentions',
      icon: 'Link',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasUnlinkedMentions,
      run: () => ctx.selectUnlinkedMentions(),
    },
    {
      // Select every card with an OPEN QUESTION — an interrogative line in its text (b150), the board's
      // unanswered threads. Board-global (like Select-orphans): ignores the current selection and swaps to the
      // question cards. Gated to a board that HAS one so the row never shows as a dead no-op (L118).
      id: 'select-questions',
      label: 'Select open questions',
      icon: 'HelpCircle',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasQuestions,
      run: () => ctx.selectQuestions(),
    },
    {
      // Select every card in a TITLE COLLISION — a title borne by ≥2 cards (b151), where `[[link]]` resolves to
      // the first and shadows the rest. Board-global (like Select-orphans): ignores the current selection and
      // swaps to the ambiguous cards so they can be renamed/merged. Gated to a board that HAS a collision so the
      // row never shows as a dead no-op (L118).
      id: 'select-duplicate-titles',
      label: 'Select duplicate titles',
      icon: 'Copy',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasDuplicateTitles,
      run: () => ctx.selectDuplicateTitles(),
    },
    {
      // Select every card carrying a NEAR-DUPLICATE tag — distinct spellings of one intent (`to-do` vs `todo`,
      // b152), so the user can re-tag them onto one canonical form. Board-global (like Select-orphans): ignores
      // the current selection. Gated to a board that HAS fragmentation so the row never shows as a dead no-op (L118).
      id: 'select-fragmented-tags',
      label: 'Select near-duplicate tags',
      icon: 'Tags',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasFragmentedTags,
      run: () => ctx.selectFragmentedTags(),
    },
    {
      // UNIFY every near-duplicate tag onto its canonical (most-used) spelling in one undoable batch (b156) —
      // the one-click FIX that completes b152's detect→select. Board-global; a MUTATION, not a selection.
      // Gated by the SAME boardHasFragmentedTags so it appears exactly when there is fragmentation to fix (L118).
      id: 'unify-fragmented-tags',
      label: 'Unify near-duplicate tags',
      icon: 'Combine',
      priority: 6,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasFragmentedTags,
      run: () => ctx.unifyFragmentedTags(),
    },
    {
      // Select the LARGEST connected cluster (b153) — the board's main structure — so a fragmented canvas (≥2
      // disconnected mind-maps sharing a page) can have its primary map isolated from the side-clusters.
      // Board-global (like Select-orphans): ignores the current selection. Gated to a fragmented board so the
      // row never shows when everything is already one connected structure (L118).
      id: 'select-largest-cluster',
      label: 'Select largest cluster',
      icon: 'Network',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasMultipleClusters,
      run: () => ctx.selectLargestCluster(),
    },
    {
      // Select the REDUNDANT connectors (b154) — every duplicate line beyond the one kept per relationship — so
      // a board whose connectors have accumulated accidental double-draws can be de-duplicated in one delete.
      // Board-global (like Select-orphans): ignores the current selection. Gated to a board that HAS a duplicate
      // so the row never shows on a clean connector graph (L118).
      id: 'select-redundant-connectors',
      label: 'Select duplicate connectors',
      icon: 'Spline',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasDuplicateConnectors,
      run: () => ctx.selectRedundantConnectors(),
    },
    {
      // Select the SOURCE cards (b157) — the dependency graph's starting points (nothing points to them).
      // Board-global (like Select-orphans). Gated to a board that HAS a source so the row is never a dead
      // no-op (L118).
      id: 'select-sources',
      label: 'Select starting points',
      icon: 'LogIn',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasSources,
      run: () => ctx.selectSources(),
    },
    {
      // Select the SINK cards (b157) — the dependency graph's final outcomes (they point to nothing).
      // Board-global. Gated to a board that HAS a sink (L118).
      id: 'select-sinks',
      label: 'Select final outcomes',
      icon: 'LogOut',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasSinks,
      run: () => ctx.selectSinks(),
    },
    {
      // Select the UNDATED cards (b158) — the tasks still missing a deadline on a partly-scheduled board.
      // Board-global (like Select-orphans). Gated to a board with a date GAP (some dated, some not) so it is
      // never a dead no-op on an unscheduled or fully-scheduled board (L118).
      id: 'select-undated',
      label: 'Select cards without a date',
      icon: 'CalendarOff',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasDateGaps,
      run: () => ctx.selectUndatedCards(),
    },
    {
      // Select the cards sharing the board's TOP recurring theme (b159) — the biggest implicit topic cluster,
      // mined from the cards' own prose (no tag needed). Board-global. Gated to a board that HAS a recurring
      // theme (a term on ≥2 cards) so it never fires on a board with no shared subject matter (L118).
      id: 'select-top-theme',
      label: 'Select cards about the top theme',
      icon: 'Sparkles',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasThemes,
      run: () => ctx.selectTopThemeCards(),
    },
    {
      // Select the cards carrying an external link (b160) — the board's cited sources. Board-global. Gated to a
      // board that HAS a link so it never fires on a link-free board (L118).
      id: 'select-linked-cards',
      label: 'Select cards with a link',
      icon: 'Link',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasLinks,
      run: () => ctx.selectLinkedCards(),
    },
    {
      // Select the cards worth splitting (b161) — the mini-documents the Split action would break into ≥2 cards.
      // Board-global. Gated to a board that HAS a candidate so it never fires when nothing would split (L118).
      id: 'select-split-candidates',
      label: 'Select cards to split',
      icon: 'SplitSquareVertical',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasSplitCandidates,
      run: () => ctx.selectSplitCandidates(),
    },
    {
      // Select the UNTAGGED cards (b162) — the cards still missing a tag on a partly-tagged board. Board-global.
      // Gated to a board with a tag GAP (some tagged, some not) so it never fires on an untagged or fully-tagged
      // board (L118). The tag-dimension sibling of Select-cards-without-a-date.
      id: 'select-untagged',
      label: 'Select untagged cards',
      icon: 'Tags',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasTagGaps,
      run: () => ctx.selectUntaggedCards(),
    },
    {
      // Select the cards in the board's DOMINANT relationship (b163) — the endpoints of the most-used connector
      // kind (e.g. every card in the 'blocks' chain). Board-global. Gated to a board that HAS a connector so it
      // never fires on a diagram-free board (L118).
      id: 'select-main-relationship',
      label: 'Select the main relationship',
      icon: 'Waypoints',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasRelationships,
      run: () => ctx.selectMainRelationshipCards(),
    },
    {
      // Select every card flagged by a health signal (b164) — orphans, ambiguous titles, untagged, etc. — so
      // you can fix them in one pass. Board-global. Gated to a board that HAS an issue so it is never a dead
      // no-op on a clean board (L118).
      id: 'select-health-issues',
      label: 'Select cards with issues',
      icon: 'ShieldAlert',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasHealthIssues,
      run: () => ctx.selectHealthIssueCards(),
    },
    {
      // Select the cards in the board's LARGEST colour family (b166) — the top row of the colour legend, via
      // the generic facet census over the `colorFamily` extractor. Distinct from `select-same-fill` (which needs
      // an anchor and matches the EXACT hex): this is board-global and picks the dominant human hue. Gated to a
      // board that HAS a colour so it never fires on a colourless board (L118).
      id: 'select-largest-color-group',
      label: 'Select the largest colour group',
      icon: 'Palette',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasColorGroups,
      run: () => ctx.selectLargestColorGroup(),
    },
    {
      // Select the cards carrying the board's STRONGEST tag pair (b168) — the two tags that keep sharing a card,
      // via the generic co-occurrence reducer over the tag extractor. Board-global. Gated to a board that HAS a
      // co-occurring pair so it never fires when no two tags ever share a card (L118).
      id: 'select-strongest-tag-pair',
      label: 'Select the strongest tag pair',
      icon: 'Tags',
      priority: 5,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.boardHasTagPairs,
      run: () => ctx.selectStrongestTagPair(),
    },
    {
      id: 'select-same-tag',
      label: 'Select all sharing a tag',
      icon: 'Tags',
      priority: 6,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasTags,
      run: (refs) => ctx.selectSameTag(membersOfRefs(refs)),
    },
    {
      id: 'select-same-fill',
      label: 'Select all of this colour',
      icon: 'Palette',
      priority: 7,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasFill,
      run: (refs) => ctx.selectSameFill(membersOfRefs(refs)),
    },
    // Select-similar by the now-first-class per-item marker (cont.12) + shape (cont.13) — the same
    // `similarIds` engine + injected criterion the kind/tag/fill rows use (the selection sibling of
    // the Group-by-marker/shape facets): select all ✓ items to bulk-clear a checklist, or all diamonds
    // to recolour the decisions. Gated so the row only shows when the anchor actually has one (L118).
    {
      id: 'select-same-marker',
      label: 'Select all with this marker',
      icon: 'ListChecks',
      priority: 8,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasMarker,
      run: (refs) => ctx.selectSameMarker(membersOfRefs(refs)),
    },
    {
      id: 'select-same-shape',
      label: 'Select all of this shape',
      icon: 'Shapes',
      priority: 9,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasShape,
      run: (refs) => ctx.selectSameShape(membersOfRefs(refs)),
    },
    // Keep items together without moving them: they share one group id (Spatial's parentStack), so selecting one selects
    // them all, and the group dissolves by clearing the id. Unlike a Section nothing is wrapped or repositioned.
    geom('group-in-place', 'Group (keep in place)', 'Link', 9, 2, (g, ids, p) => assignGroupId(g, p, ids, `group-${crypto.randomUUID()}`)),
    geom('ungroup-in-place', 'Ungroup (keep in place)', 'Unlink', 9, 1, (g, ids, p) => {
      const taken = new Set(readItems(g, p).filter((item) => ids.includes(item.memberId)).map(groupIdOf));
      return [...taken].reduce((graph, id) => (id ? releaseGroupId(graph, p, id) : graph), g);
    }),
    geom('align-left', 'Align left', 'AlignStartVertical', 10, 2, (g, ids, p) => alignBoxes(g, p, ids, 'left')),
    geom('align-hcenter', 'Align center', 'AlignCenterVertical', 11, 2, (g, ids, p) => alignBoxes(g, p, ids, 'hcenter')),
    geom('align-right', 'Align right', 'AlignEndVertical', 12, 2, (g, ids, p) => alignBoxes(g, p, ids, 'right')),
    geom('align-top', 'Align top', 'AlignStartHorizontal', 13, 2, (g, ids, p) => alignBoxes(g, p, ids, 'top')),
    geom('align-vcenter', 'Align middle', 'AlignCenterHorizontal', 14, 2, (g, ids, p) => alignBoxes(g, p, ids, 'vcenter')),
    geom('align-bottom', 'Align bottom', 'AlignEndHorizontal', 15, 2, (g, ids, p) => alignBoxes(g, p, ids, 'bottom')),
    geom('distribute-h', 'Distribute across', 'Columns3', 20, 3, (g, ids, p) => distributeBoxes(g, p, ids, 'h')),
    geom('distribute-v', 'Distribute down', 'Rows3', 21, 3, (g, ids, p) => distributeBoxes(g, p, ids, 'v')),
    geom('space-evenly-h', 'Space evenly across', 'AlignHorizontalSpaceAround', 18, 3, (g, ids, p) => distributeSpacing(g, p, ids, 'h')),
    geom('space-evenly-v', 'Space evenly down', 'AlignVerticalSpaceAround', 19, 3, (g, ids, p) => distributeSpacing(g, p, ids, 'v')),
    {
      // Type an EXACT gap (#130). Auto-axis + the px prompt live in the board; the
      // engine `distributeByGap` is blind. minCount 2 (a single item has no gap).
      id: 'space-by-gap',
      label: 'Space by exact gap…',
      icon: 'MoveHorizontal',
      priority: 17,
      minCount: 2,
      accepts: onlyBoardItems,
      run: () => ctx.spaceByGap(),
    },
    geom('snap-to-grid', 'Snap to grid', 'Grid3x3', 22, 1, (g, ids, p) => snapToGrid(g, p, ids, BOARD_GRID)),
    geom('tidy-grid', 'Tidy into grid', 'LayoutGrid', 23, 2, (g, ids, p) => tidyGrid(g, p, ids, BOARD_GRID)),
    // #202 — the column/row siblings of Tidy: the SAME `arrangeUniform` primitive
    // with a different injected `colsFor` (1 = single column, N = single row). The
    // Milanote-class "stack these into a column" organiser a vision board is built
    // around. Auto-appears in the bulk bar + ⌘K palette (zero UI code); lock-safe via
    // the geom `unlockedOf` wrap. Rows3 icon reads as stacked rows = a column.
    geom('arrange-column', 'Stack in column', 'Rows3', 24, 2, (g, ids, p) => arrangeUniform(g, p, ids, BOARD_GRID, () => 1)),
    geom('arrange-row', 'Stack in row', 'Columns3', 25, 2, (g, ids, p) => arrangeUniform(g, p, ids, BOARD_GRID, (n) => n)),
    // #203 — the emergence proof: a circle the column-count-only `arrangeUniform` can
    // never produce, now one DATA row via the deeper `arrangeBy` + `radialPlacement`.
    geom('arrange-circle', 'Arrange in circle', 'Circle', 26, 3, (g, ids, p) => arrangeBy(g, p, ids, BOARD_GRID, radialPlacement())),
    // Masonry (Pinterest/Milanote) — pack mixed-height items into ≈√n fixed-width columns, each into
    // the shortest column. The dense layout grid can't produce (uniform rowPitch wastes space on a
    // board of images + short notes). One more DATA placement over the SAME arrangeBy engine (L069).
    geom('arrange-masonry', 'Pack as masonry', 'LayoutDashboard', 32, 3, (g, ids, p) => arrangeBy(g, p, ids, BOARD_GRID, masonryPlacement((n) => Math.ceil(Math.sqrt(n))))),
    // SORT arrangements — inject a content comparator as the traversal ORDER (default = reading
    // order) so the SAME arrangeBy engine orders items by meaning, not position: A→Z alphabetises
    // into a column, "by size" grids biggest-first. A new sort = one comparator, ZERO engine change.
    geom('arrange-sort-az', 'Sort A→Z', 'ArrowDownAZ', 33, 2, (g, ids, p) => arrangeBy(g, p, ids, BOARD_GRID, flowPlacement(() => 1), byTextAsc)),
    geom('arrange-sort-size', 'Sort by size', 'ArrowDownWideNarrow', 34, 2, (g, ids, p) => arrangeBy(g, p, ids, BOARD_GRID, flowPlacement((n) => Math.ceil(Math.sqrt(n))), byAreaDesc)),
    // Rainbow — order the selection around the colour wheel (a user's "organize by colour palette"):
    // a THIRD sort comparator (byHue) over the SAME injectable-order arrangeBy, greys gathered last.
    geom('arrange-sort-color', 'Sort by color', 'Palette', 35, 2, (g, ids, p) => arrangeBy(g, p, ids, BOARD_GRID, flowPlacement((n) => Math.ceil(Math.sqrt(n))), byHue)),
    // Sort by COMPLETION (most-done first) and by DUE DATE (soonest first) — two more comparators over
    // the SAME injectable-order arrangeBy, each ZERO engine change. `byProgressDesc` reads the card's
    // unified metric-or-checklist progress (pre-derived on Box), `byDueAsc` its due date; no-progress /
    // undated cards gather LAST (like the rainbow's greys). Progress → a column, due → a tidy chrono list.
    geom('arrange-sort-progress', 'Sort by progress', 'ArrowDownWideNarrow', 36, 2, (g, ids, p) => arrangeBy(g, p, ids, BOARD_GRID, flowPlacement(() => 1), byProgressDesc)),
    geom('arrange-sort-due', 'Sort by due date', 'CalendarArrowDown', 37, 2, (g, ids, p) => arrangeBy(g, p, ids, BOARD_GRID, flowPlacement(() => 1), byDueAsc)),
    // §9.1 — arrange the selection into CLUSTERS by a facet ("sort my board into
    // groups by tag / kind / color"). Each row injects a `keyOf` criterion — the SAME
    // extractor contract Select-similar injects into `similarIds` (one primitive, two
    // consumers: filter there, partition here) — into the ONE `arrangeByFacet` engine.
    // A future facet (progress, owner, deadline) is one more row, ZERO engine change.
    // Lock-safe + auto-surfaced in the bulk bar, right-click menu and ⌘K palette via
    // the shared `geom` chokepoint, like every other arrangement.
    geom('arrange-by-tag', 'Group by tag', 'Tags', 27, 2, (g, ids, p) => arrangeByFacetLabeled(g, p, ids, BOARD_GRID, (i) => itemTags(i), { facetId: 'tag', emptyLabel: 'Untagged' })),
    geom('arrange-by-kind', 'Group by kind', 'Shapes', 28, 2, (g, ids, p) => arrangeByFacetLabeled(g, p, ids, BOARD_GRID, (i) => i.kind, { facetId: 'kind', emptyLabel: 'Other' })),
    geom('arrange-by-fill', 'Group by color', 'Palette', 29, 2, (g, ids, p) => arrangeByFacetLabeled(g, p, ids, BOARD_GRID, (i) => itemFillColor(i) ?? '', { facetId: 'fill', emptyLabel: 'No colour' })),
    // Emergent facets composing the now-first-class per-item marker (cont.12) and shape (cont.13)
    // with this SAME arrange-by-facet engine: a checklist/status board groups by its per-item bullet
    // (✓/★/☐ regions — a user's "sort into groups by progress"), a diagram board groups by node shape.
    // keyOf reads the item's OWN `extra.marker`/`extra.shape` (the meaningful axis — a board-DEFAULT
    // applies to all, so grouping by the per-item value is what separates them); notes with none fall
    // into the labelled empty bucket. labelMap = the catalog SSOT → readable '✓ Check' / 'Ellipse'
    // headings. A new marker/shape row auto-appears in these labels (L090). Zero engine change.
    geom('arrange-by-marker', 'Group by marker', 'ListChecks', 30, 2, (g, ids, p) => arrangeByFacetLabeled(g, p, ids, BOARD_GRID, (i) => (typeof i.extra?.marker === 'string' ? i.extra.marker : ''), { facetId: 'marker', labelMap: MARKER_FACET_LABELS, emptyLabel: 'No marker' })),
    geom('arrange-by-shape', 'Group by shape', 'Shapes', 31, 2, (g, ids, p) => arrangeByFacetLabeled(g, p, ids, BOARD_GRID, (i) => (typeof i.extra?.shape === 'string' ? i.extra.shape : ''), { facetId: 'shape', labelMap: SHAPE_FACET_LABELS, emptyLabel: 'No shape' })),
    // §9.4 (continuous) — PLOT the selection along a NUMERIC axis, the continuous sibling of the
    // group-by-facet rows above. Each row injects a numeric `valueOf` (the continuous analog of the
    // discrete `keyOf`) into the ONE blind `arrangeSelectionOnAxis` engine — the field is DATA, the
    // engine never names it (L090). "Line up by length" is a 1-D number-line by note text length
    // (empty notes park below); "Plot size vs length" is a 2-D scatter (x = card area, y = length) —
    // a "big & detailed vs small & sparse" quadrant. A future numeric (date, price, progress) is one
    // more row, ZERO engine change. Same lock-safe `geom` chokepoint → auto-surfaced in bulk bar / ⌘K.
    geom('arrange-by-length', 'Line up by length', 'Ruler', 32, 2, (g, ids, p) => arrangeSelectionOnAxis(g, p, ids, (i) => ({ x: typeof i.text === 'string' && i.text.length > 0 ? i.text.length : null }), { showAxis: true })),
    geom('arrange-scatter-size-length', 'Plot size vs length', 'ScatterChart', 33, 2, (g, ids, p) => arrangeSelectionOnAxis(g, p, ids, (i) => ({ x: i.w * i.h, y: typeof i.text === 'string' && i.text.length > 0 ? i.text.length : null }), { showAxis: true })),
    // §9.5 ROADMAP / TIMELINE (Gantt): continuous X (card size) × discrete swimlanes (kind). The
    // composition of the axis + facet families — one lane per kind, each labelled, cards placed by
    // value within their band. laneOf/valueOf are DATA lambdas; a future date/owner axis is one row.
    geom('arrange-timeline-kind', 'Roadmap by kind', 'GanttChart', 34, 2, (g, ids, p) => arrangeSelectionAsTimeline(g, p, ids, (i) => i.w * i.h, (i) => i.kind, { emptyLabel: 'Other' })),
    // §9.4 DATE AXIS — the emergent row the axis family's own comment predicted ("a future numeric
    // (date, price, progress) is one more row, ZERO engine change"). A 1-D TIMELINE by the item's
    // `extra.dueDate`: `dueDateOfItem` returns the epoch-ms (fail-closed null when absent, so undated
    // cards park in the no-value pile below the line), the SAME blind `arrangeSelectionOnAxis` engine
    // scales them left→right in time, and `dueMsToDateLabel` renders the axis ticks as real `YYYY-MM-DD`
    // dates (deterministic UTC). Zero engine change — a due date is just another injected `valueOf` (L069/L090).
    geom('arrange-timeline-due', 'Line up on a timeline by due date', 'CalendarClock', 35, 2, (g, ids, p) => arrangeSelectionOnAxis(g, p, ids, (i) => ({ x: dueDateOfItem(i) }), { showAxis: true, format: dueMsToDateLabel })),
    // §9.4 HETEROGENEOUS 2-D SCATTER — the emergent proof that the per-axis-formatter completion works:
    // x = due date (formatX = YYYY-MM-DD), y = checklist progress (formatY = %). A card with no checklist
    // has no progress value → y=null → it parks in the pile (distinct from a 0%-done checklist, y=0, which
    // plots at the bottom). "What's due soon AND barely started?" falls out of ONE engine — two injected
    // accessors + two injected label formatters, ZERO geometry code (L069/L090). A future price×count or
    // date×score scatter is one more row.
    geom('arrange-scatter-due-progress', 'Plot due date vs progress', 'CalendarRange', 36, 2, (g, ids, p) => arrangeSelectionOnAxis(g, p, ids, (i) => {
      const list = checklistFromRaw(i.extra?.checklist);
      return { x: dueDateOfItem(i), y: list.length > 0 ? checklistProgress(list).fraction : null };
    }, { showAxis: true, formatX: dueMsToDateLabel, formatY: (v) => `${Math.round(v * 100)}%`, domainY: { min: 0, max: 1 } })),
    // §9.4 emergent (b84) — DOT-VOTING plotted spatially: the vote-tally primitive (`board-votes`) and
    // the axis engine already exist; a card's vote count is just another injected `valueOf`, so "line up
    // by votes" (1-D priority number-line, ticks = integer dot counts) and "plot votes vs progress"
    // (2-D: popular-but-unstarted ideas surface top-right) fall out with ZERO geometry code — the exact
    // L069 payoff (votes × axis). Unvoted cards park in the no-value pile (votesAxisValue → null).
    geom('arrange-by-votes', 'Line up by votes', 'Vote', 38, 2, (g, ids, p) => arrangeSelectionOnAxis(g, p, ids, (i) => ({ x: votesAxisValue(i) }), { showAxis: true, format: (v) => `${Math.round(v)}` })),
    geom('arrange-scatter-votes-progress', 'Plot votes vs progress', 'ScatterChart', 39, 2, (g, ids, p) => arrangeSelectionOnAxis(g, p, ids, (i) => {
      const list = checklistFromRaw(i.extra?.checklist);
      return { x: votesAxisValue(i), y: list.length > 0 ? checklistProgress(list).fraction : null };
    }, { showAxis: true, formatX: (v) => `${Math.round(v)}`, formatY: (v) => `${Math.round(v * 100)}%`, domainY: { min: 0, max: 1 } })),
    // b147 — TRANSITIVE IMPORTANCE (PageRank) plotted spatially: the graph exists (`relationship-graph`) and
    // the axis engine exists, so a card's recursive importance (`board-importance`, precomputed once over the
    // whole board's connectors, then a per-item lookup) is just another injected `valueOf` — "line up by
    // importance" (1-D: the core ideas everything traces back to float to one end) and "plot importance vs
    // progress" (2-D: high-importance / low-progress = the neglected keystone ideas, top-left). ZERO geometry
    // code — the L069 payoff (PageRank × axis). DISTINCT from Group-by-hub (degree): importance is recursive.
    geom('arrange-by-importance', 'Line up by importance', 'Sparkles', 40, 2, (g, ids, p) => {
      const ranks = importanceRanks(readItems(g, p));
      return arrangeSelectionOnAxis(g, p, ids, (i) => ({ x: importanceValue(ranks, i.memberId) }), { showAxis: true, format: (v) => v.toFixed(3) });
    }),
    geom('arrange-scatter-importance-progress', 'Plot importance vs progress', 'ScatterChart', 41, 2, (g, ids, p) => {
      const ranks = importanceRanks(readItems(g, p));
      return arrangeSelectionOnAxis(g, p, ids, (i) => ({ x: importanceValue(ranks, i.memberId), y: cardCompletion(i) ?? null }), { showAxis: true, formatX: (v) => v.toFixed(3), formatY: (v) => `${Math.round(v * 100)}%`, domainY: { min: 0, max: 1 } });
    }),
    // b148 — GRAPH COMMUNITIES (Louvain) grouped into labelled regions: the dense TOPIC clusters inside a
    // connected board (`board-communities`, precomputed once over the whole board's connectors, then a
    // per-card lookup) fed into the SAME blind labelled-facet wrapper as Group-by-tag/marker — so "Group by
    // cluster" (row-grid group areas) and "Kanban by cluster" (columns) fall out with ZERO new geometry
    // (L069). DISTINCT from Group-by-hub (degree) + components (hard islands): communities are soft dense
    // groups WITHIN one connected graph. Singleton communities pile into "Unclustered" so the facet stays clean.
    geom('arrange-by-cluster', 'Group by cluster', 'Network', 42, 2, (g, ids, p) => {
      const { keyOf, labelMap } = numberedCommunities(readItems(g, p));
      return arrangeByFacetLabeled(g, p, ids, BOARD_GRID, keyOf, { facetId: 'cluster', labelMap, emptyLabel: 'Unclustered' });
    }),
    geom('kanban-by-cluster', 'Kanban by cluster', 'Columns3', 42, 2, (g, ids, p) => {
      const { keyOf, labelMap } = numberedCommunities(readItems(g, p));
      return arrangeByFacetLabeled(g, p, ids, BOARD_GRID, keyOf, { facetId: 'cluster', labelMap, emptyLabel: 'Unclustered', layout: arrangeColumns });
    }),
    // cont.45 — KANBAN (columns-by-value, §9.2 emergent): the SAME labelled-facet wrapper, but the
    // injected `arrangeColumns` geometry lays each value as a vertical COLUMN placed left-to-right
    // (a status board "To do | Doing | Done") instead of stacked row-grid groups. ONE new geometry
    // fn + one `layout` arg — the self-clean + labelled headers are reused unchanged (L069). Same
    // `facetId` as Group-by so switching between group ↔ kanban self-cleans the headers (no dup).
    geom('kanban-by-tag', 'Kanban by tag', 'Columns3', 27, 2, (g, ids, p) => arrangeByFacetLabeled(g, p, ids, BOARD_GRID, (i) => itemTags(i), { facetId: 'tag', emptyLabel: 'Untagged', layout: arrangeColumns })),
    geom('kanban-by-kind', 'Kanban by kind', 'Columns3', 28, 2, (g, ids, p) => arrangeByFacetLabeled(g, p, ids, BOARD_GRID, (i) => i.kind, { facetId: 'kind', emptyLabel: 'Other', layout: arrangeColumns })),
    // §9.3 (cont.19) — 2-FACET MATRIX (cross-tab): the SAME `keyOf` extractor injected on BOTH axes
    // via the ONE blind `arrangeMatrix` engine, so the board becomes a priority-quadrant grid
    // (columns = facet X, rows = facet Y) with labelled column + row headers. Each row is a DATA
    // pair of two existing facets — a marker×colour status/priority board, a kind×tag map — ZERO
    // engine change per matrix (Codex-converged L069: status×assignee, effort×impact, any 2 facets
    // emerge from DATA). Lock-safe + auto-surfaced via the shared `geom` chokepoint like every arrange.
    geom('arrange-matrix-marker-fill', 'Matrix: marker × colour', 'Grid3x3', 32, 2, (g, ids, p) => arrangeByMatrixLabeled(g, p, ids, (i) => (typeof i.extra?.marker === 'string' ? i.extra.marker : ''), (i) => itemFillColor(i) ?? '', BOARD_GRID, { facetIdX: 'marker', facetIdY: 'fill', labelMapX: MARKER_FACET_LABELS, emptyLabelX: 'No marker', emptyLabelY: 'No colour' })),
    geom('arrange-matrix-kind-tag', 'Matrix: kind × tag', 'Grid3x3', 32, 2, (g, ids, p) => arrangeByMatrixLabeled(g, p, ids, (i) => i.kind, (i) => itemTags(i), BOARD_GRID, { facetIdX: 'kind', facetIdY: 'tag', emptyLabelX: 'Other', emptyLabelY: 'Untagged' })),
    {
      // §9.4 (cont.22) — SPREAD OUT: un-stack a pile, preserving the rough layout (distinct from the
      // arrange rows above, which impose a new structure). Passes the FULL selection (NOT unlockedOf)
      // so LOCKED items anchor as immovable PINS the movers flow around — the one geometry op that
      // must see the locked members. Gated on ≥2 nodes (L118).
      id: 'spread-out',
      label: 'Spread out',
      icon: 'Shrink',
      priority: 33,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.multipleNodesSelected,
      run: (refs) => ctx.applyBatch((g, _ids, p) => spreadOutOverlaps(g, p, membersOfRefs(refs), BOARD_GRID)),
    },
    // §9.5 (cont.23) — apply a cohesive colour THEME to the selection. The rows are GENERATED from the
    // BOARD_PALETTES DATA catalog (never hand-written — a new theme is one catalog row, ZERO row code;
    // Codex: hand-naming each palette would be half instance-solving). Each recolours via cycleAssign
    // (round-robin in reading order); lock-safe via the shared geom chokepoint; recoloured notes auto-
    // get legible text through cont.21's readable ink. L090: the engine never names a theme.
    ...BOARD_PALETTES.map((pal) =>
      geom(`palette-${pal.id}`, `Palette: ${pal.label}`, 'Palette', 34, 2, (g, ids, p) => recolorSelectionToPalette(g, p, ids, pal, cycleAssign)),
    ),
    // §9.6 (cont.24) — generate a colour-THEORY scheme from the anchor sticky's colour and theme the
    // board with it. Rows GENERATED from the BOARD_HARMONY_SCHEMES catalog (a new scheme = one row,
    // ZERO row code). Gated on `anchorHasFill` (needs a seed colour, L118 — never a dead no-op).
    // Passes the FULL selection so the anchor's colour is the seed even if it is locked; the recolour
    // skips locked items internally. Composes cont.18 (hue) + cont.23 (recolour) + cont.21 (auto ink).
    ...BOARD_HARMONY_SCHEMES.map((scheme) => ({
      id: `harmonize-${scheme.id}`,
      label: `Harmonize: ${scheme.label}`,
      icon: 'Palette',
      priority: 35,
      minCount: 2,
      accepts: (refs: readonly NodeRef[]) => onlyBoardItems(refs) && ctx.anchorHasFill,
      run: (refs: readonly NodeRef[]) => ctx.applyBatch((g, _ids, p) => harmonizeSelectionFromAnchor(g, p, membersOfRefs(refs), scheme)),
    })),
    // cont.42 — COLOUR BY FACET (the third organise axis after arrange-by-facet (position) and
    // focus-by-facet (dim)). Rows GENERATED from the COLOR_BY_FACETS DATA catalog (a new colourable
    // facet is one row, ZERO code). Each partitions the selection by a facet value and paints each
    // group a distinct palette colour via `recolorSelectionByFacet` (reusing the theme-recolour engine
    // + the `byFacetAssign` strategy). Gated on ≥2 DISTINCT values of that facet in the selection so
    // the row is never a dead no-op (one colour isn't a "colour BY" grouping — L118). Lock-safe via
    // unlockedOf, exactly like the geom rows. L090: the engine never names the facet.
    ...COLOR_BY_FACETS.map((f) => ({
      id: `color-by-${f.id}`,
      label: f.label,
      icon: 'Palette',
      priority: 25,
      minCount: 2,
      accepts: (refs: readonly NodeRef[]) => onlyBoardItems(refs) && (ctx.distinctFacetValues[f.facet] ?? 0) >= 2,
      run: (refs: readonly NodeRef[]) =>
        ctx.applyBatch((g, _ids, p) => recolorSelectionByFacet(g, p, unlockedOf(g, membersOfRefs(refs), p), BOARD_PALETTES[0], f.extractor)),
    })),
    // Topology-aware auto-layout (#161 + cont.25) — reflow the connector-linked selection BY its
    // graph structure. The rows are GENERATED from the GRAPH_LAYOUTS DATA catalog (tidy tree /
    // layered flowchart / radial mind-map — a new layout is ONE catalog row + one strategy fn, ZERO
    // row code; L090 the board never names a layout). Full members are passed (NOT `unlockedOf`) so
    // LOCKED nodes anchor the topology as pins inside `arrangeByGraph` (Codex: locked nodes still
    // define structure). Gated on `selectionHasConnectors` so no row is ever a dead no-op (L118).
    ...GRAPH_LAYOUTS.map((layout) => ({
      id: `graph-layout-${layout.id}`,
      label: layout.label,
      icon: layout.icon,
      priority: 16,
      minCount: 2,
      accepts: (refs: readonly NodeRef[]) => onlyBoardItems(refs) && ctx.selectionHasConnectors,
      run: (refs: readonly NodeRef[]) =>
        ctx.applyBatch((g, _ids, p) => arrangeByGraph(g, p, membersOfRefs(refs), layout.strategy, {})),
    })),
    {
      // Rainbow branches (#165) — colour each top-level branch of the selected mind-map a
      // distinct hue so a dense tidied map reads at a glance (MindNode/XMind canon). The
      // board owns the DATA palette + the fill apply (reuses #124's `setStackFill` path);
      // `branchColorAssignments` is the blind topology→colour engine. Same gate as
      // arrange-mindmap (`selectionHasConnectors`) so the row is never a dead no-op (L118).
      id: 'color-branches',
      label: 'Color branches',
      icon: 'Paintbrush',
      priority: 24,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.selectionHasConnectors,
      run: (refs) => ctx.colorBranches(membersOfRefs(refs)),
    },
    {
      // Copy the selected mind-map as a Markdown outline (#184) — read the tree back out
      // into a doc/notes/email. The board serializes via the pure `mindMapOutline` and
      // writes to the clipboard. Same gate as arrange/colour (`selectionHasConnectors`) so
      // the row only appears when a real tree exists (L118 — never a dead no-op).
      id: 'copy-outline',
      label: 'Copy as outline',
      icon: 'ListTree',
      priority: 23,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && ctx.selectionHasConnectors,
      run: (refs) => ctx.copyOutline(membersOfRefs(refs)),
    },
    {
      // Select the anchor's whole branch (#186) — the node + every connector-descendant, so
      // a user can grab a subtree in one click to move/colour/delete/collapse it (MindNode/
      // XMind "select branch"). Pure `branchMemberIds` off the live board; the board owns the
      // selection swap. Same anchor + gate as collapse-branch (a real subtree must exist), but
      // accepts a HIDDEN subtree too so a collapsed branch is still selectable.
      id: 'select-branch',
      label: 'Select branch',
      icon: 'ListTree',
      priority: 6,
      minCount: 1,
      accepts: (refs) =>
        onlyBoardItems(refs) && (ctx.anchorHasVisibleDescendants || ctx.anchorHasHiddenDescendants),
      run: (refs) => ctx.selectBranch(membersOfRefs(refs)),
    },
    {
      // Select the anchor's whole UPSTREAM lineage — the node + every transitive ancestor (what
      // leads INTO it). The all-connector mirror of "Select branch" (which selects DOWNSTREAM):
      // grab everything feeding a node for impact analysis / to move-colour-delete the lineage.
      // Pure `upstreamMemberIds` off the live board; gated on the anchor actually having ancestors.
      id: 'select-upstream',
      label: 'Select upstream',
      icon: 'GitBranch',
      priority: 6,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasAncestors,
      run: (refs) => ctx.selectUpstream(membersOfRefs(refs)),
    },
    {
      // Collapse the anchor's connector-subtree (#162) — focus a dense mind map by hiding
      // every descendant. Composes the #149 visibility primitive: `setBranchHidden` flips
      // `extra.hidden` on the subtree, which the board already removes + whose connectors it
      // already auto-suppresses. Anchor = last selected; gated on a real visible subtree.
      id: 'collapse-branch',
      label: 'Collapse branch',
      icon: 'ChevronsDownUp',
      priority: 16,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasVisibleDescendants,
      run: (refs) => {
        const ids = membersOfRefs(refs);
        const anchor = ids[ids.length - 1];
        if (anchor) ctx.applyBatch((g, _ids, p) => setBranchHidden(g, p, anchor, true));
      },
    },
    {
      // Expand the anchor's collapsed subtree (#162) — restore every hidden descendant.
      id: 'expand-branch',
      label: 'Expand branch',
      icon: 'ChevronsUpDown',
      priority: 16,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anchorHasHiddenDescendants,
      run: (refs) => {
        const ids = membersOfRefs(refs);
        const anchor = ids[ids.length - 1];
        if (anchor) ctx.applyBatch((g, _ids, p) => setBranchHidden(g, p, anchor, false));
      },
    },
    geom('flip-horizontal', 'Flip horizontal', 'FlipHorizontal2', 24, 1, (g, ids, p) => flipItems(g, p, ids, 'x')),
    geom('flip-vertical', 'Flip vertical', 'FlipVertical2', 25, 1, (g, ids, p) => flipItems(g, p, ids, 'y')),
    geom('rotate-cw', 'Rotate 90° right', 'RotateCw', 26, 1, (g, ids, p) => rotateItems(g, p, ids, 90)),
    geom('rotate-ccw', 'Rotate 90° left', 'RotateCcw', 27, 1, (g, ids, p) => rotateItems(g, p, ids, -90)),
    geom('equal-width', 'Same width', 'MoveHorizontal', 30, 2, (g, ids, p) => equalSize(g, p, ids, 'w', ids[0] ?? null)),
    geom('equal-height', 'Same height', 'MoveVertical', 31, 2, (g, ids, p) => equalSize(g, p, ids, 'h', ids[0] ?? null)),
    geom('equal-size', 'Same size', 'Maximize', 32, 2, (g, ids, p) => equalSize(g, p, ids, 'both', ids[0] ?? null)),
    {
      id: 'tag',
      label: 'Tag',
      icon: 'Tag',
      priority: 33,
      minCount: 1,
      accepts: onlyBoardItems,
      run: (refs) => ctx.tagSelected(membersOfRefs(refs)),
    },
    geom('bring-forward', 'Bring forward', 'ArrowUp', 34, 1, (g, ids, p) => reorderZStep(g, p, ids, 'forward')),
    geom('bring-to-front', 'Bring to front', 'BringToFront', 35, 1, (g, ids, p) => reorderZ(g, p, ids, 'front')),
    geom('send-backward', 'Send backward', 'ArrowDown', 36, 1, (g, ids, p) => reorderZStep(g, p, ids, 'backward')),
    geom('send-to-back', 'Send to back', 'SendToBack', 37, 1, (g, ids, p) => reorderZ(g, p, ids, 'back')),
    {
      id: 'lock',
      label: 'Lock',
      icon: 'Lock',
      priority: 38,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anyUnlockedSelected,
      run: (refs) => ctx.applyBatch((g, _ids, p) => setLocked(g, p, membersOfRefs(refs), true)),
    },
    {
      id: 'unlock',
      label: 'Unlock',
      icon: 'LockOpen',
      priority: 39,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anyLockedSelected,
      run: (refs) => ctx.applyBatch((g, _ids, p) => setLocked(g, p, membersOfRefs(refs), false)),
    },
    {
      id: 'hide',
      label: 'Hide',
      icon: 'EyeOff',
      priority: 48,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anyVisibleSelected,
      run: (refs) => ctx.applyBatch((g, _ids, p) => setHidden(g, p, membersOfRefs(refs), true)),
    },
    {
      id: 'show',
      label: 'Show',
      icon: 'Eye',
      priority: 49,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.anyHiddenSelected,
      run: (refs) => ctx.applyBatch((g, _ids, p) => setHidden(g, p, membersOfRefs(refs), false)),
    },
    {
      id: 'isolate',
      label: 'Isolate',
      icon: 'Focus',
      priority: 51,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.canIsolate,
      run: (refs) => ctx.isolateSelection(membersOfRefs(refs)),
    },
    {
      id: 'export-selection-svg',
      label: 'Export selection (SVG)',
      icon: 'Download',
      priority: 45,
      minCount: 1,
      accepts: onlyBoardItems,
      run: (refs) => ctx.exportSelectionSvg(membersOfRefs(refs)),
    },
    {
      id: 'export-selection-png',
      label: 'Export selection (PNG)',
      icon: 'Image',
      priority: 46,
      minCount: 1,
      accepts: onlyBoardItems,
      run: (refs) => ctx.exportSelectionPng(membersOfRefs(refs)),
    },
    {
      id: 'copy-selection-png',
      label: 'Copy selection (PNG)',
      icon: 'ClipboardCopy',
      priority: 47,
      minCount: 1,
      accepts: onlyBoardItems,
      run: (refs) => ctx.copySelectionPng(membersOfRefs(refs)),
    },
    {
      id: 'apply-layers-to-all',
      label: 'Same layers as first',
      icon: 'Layers',
      priority: 40,
      minCount: 2,
      accepts: (refs) => onlyBoardItems(refs) && !!ctx.primaryBundle(),
      run: (refs) => {
        const bundle = ctx.primaryBundle();
        if (!bundle) return;
        // A locked item resists appearance paste too (lock = fully frozen).
        ctx.applyBatch((g, _ids, p) => applyBundleToAll(g, p, unlockedOf(g, membersOfRefs(refs), p), bundle));
      },
    },
    {
      id: 'save-preset',
      label: 'Save layers as preset',
      icon: 'Bookmark',
      priority: 41,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && !!ctx.primaryBundle(),
      run: () => ctx.savePreset(),
    },
    {
      id: 'apply-preset',
      label: 'Apply a preset',
      icon: 'Sparkles',
      priority: 42,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.hasPresets,
      run: () => ctx.openPresetPicker(),
    },
    {
      // Copy the anchor item's appearance into the session style clipboard; "Paste
      // style" (below, or ⌥⌘V) stamps it onto a LATER selection — the cross-time
      // sibling of "Same layers as first" (which needs source+targets selected together).
      id: 'copy-style',
      label: 'Copy style',
      icon: 'Clipboard',
      priority: 43,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && !!ctx.primaryBundle(),
      run: (refs) => ctx.copyStyle(membersOfRefs(refs)),
    },
    {
      id: 'paste-style',
      label: 'Paste style',
      icon: 'ClipboardPaste',
      priority: 44,
      minCount: 1,
      accepts: (refs) => onlyBoardItems(refs) && ctx.hasStyleClipboard,
      run: () => ctx.pasteStyle(),
    },
    {
      id: 'duplicate',
      label: 'Duplicate',
      icon: 'Copy',
      priority: 50,
      minCount: 1,
      accepts: onlyBoardItems,
      run: (refs) => ctx.duplicateSelected(membersOfRefs(refs)),
    },
    {
      id: 'group',
      label: 'Group',
      icon: 'Group',
      priority: 60,
      minCount: 2,
      accepts: onlyBoardItems,
      run: (refs) => ctx.groupSelected(membersOfRefs(refs)),
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'Trash2',
      tone: 'var(--text-danger)',
      priority: 90,
      minCount: 1,
      accepts: onlyBoardItems,
      run: (refs) => ctx.deleteSelected(membersOfRefs(refs)),
    },
  ];
}

// =============================================================================
// CONTEXT-MENU ADAPTER — the SAME batch pack, surfaced as right-click node actions.
// =============================================================================

/**
 * Adapt the board's `BatchActionCapability` rows (which act on a SET of refs) into
 * `NodeActionCapability` rows for the right-click context menu (which act on the
 * node under the cursor). The menu operates on `refsForMenu()` — the current
 * selection, reconciled on open so a right-click acts on the whole multi-selection
 * (or just the clicked item if it wasn't selected). The `minCount` gate is the
 * natural per-context curation: a 1-item menu hides align/distribute (minCount ≥2)
 * and shows rotate/flip/z-order/duplicate/lock/copy-paste-style/select-similar/delete.
 * Zero curation logic — the menu EMERGES from the pack (L090); a future batch row
 * appears in BOTH surfaces with no menu edit (deletion test).
 */
export function batchActionsAsNodeActions(
  pack: readonly BatchActionCapability[],
  refsForMenu: () => readonly NodeRef[],
): NodeActionCapability[] {
  return pack.map((cap) => ({
    id: `menu-${cap.id}`,
    label: cap.label,
    icon: cap.icon,
    tone: cap.tone,
    accepts: () => {
      const refs = refsForMenu();
      // `?? 1` mirrors `acceptedBatchActions` — a row that omits minCount defaults to 1
      // (N >= undefined is false, which would silently hide the row).
      return membersOfRefs(refs).length >= (cap.minCount ?? 1) && cap.accepts(refs);
    },
    run: () => cap.run(refsForMenu()),
  }));
}

// `BatchRunContext` is re-exported so the board can type its run-ctx without a
// second import path.
export type { BatchRunContext };
