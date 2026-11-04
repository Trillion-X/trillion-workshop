// packages/documents/do-work/build-split-transaction.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The PURE split-layout-node primitives, extracted from the surface so they are
// testable without React, the engine, or async. A "two-column / split" layout is
// NOT a backend concept — it is an ordinary scene node whose `props.style.layout`
// declares `{ mode:"split", axis, gap, parts:[{fraction}…] }`. The engine
// (`place_split_children`) lays the children out by fraction:
//
//     child_main_px = (available - gap*(n-1)) * fraction_i / Σfraction
//
// where `available` is the parent's main-axis content size, children pair with
// `parts[i]` BY INDEX, and INVISIBLE children are skipped (so a hidden column
// collapses and the rest re-expand for free — split composes with conditional
// visibility at ZERO new code). This file owns the three pure operations the
// surface needs:
//
//   1. makeSplitNode      — build an N-column split node (pure data; the engine
//                           does all layout). INVARIANT: parts.length === children.length.
//   2. visibleDividerPairs — map the VISIBLE column adjacencies to the original
//                           parts indices, so a divider between A and C (B hidden)
//                           targets parts 0↔2, never a hidden child.
//   3. applySplitDividerDrag — convert a divider pixel-drag into the new `parts`
//                           array, moving ONLY the two adjacent columns and leaving
//                           every other column's pixels unchanged.
//   4. buildSplitDividerTransaction — the UPDATE_PROPS transaction that writes the
//                           new parts back (full-props spread, like the resize path).
//
// -----------------------------------------------------------------------------
// CONVERGENCE (Codex gpt-5.5, 2026-06-20 — convergence/2026-06-20-codex-split-layout-node-*)
// -----------------------------------------------------------------------------
// The divider math was FALSIFIED and corrected before any code shipped:
//   • HIGH — px→fraction MUST scale by Σfraction. The engine sizes a column as
//     `available * f/Σf`, so moving a divider by Δpx needs Δf = Δpx * Σf / available.
//     `Δf = Δpx / available` (the naive form) moves the divider only 1/Σf of the
//     drag — the same class of bug as a resize handle lagging the cursor.
//   • HIGH — the pair-sum must be CAPTURED before mutation, then the neighbour set
//     to `pair - nextA`; an in-place read-after-write silently no-ops the neighbour.
//   • MED — the min-column floor is a fraction too: `minPart = minPx * Σf / available`.
//   • MED — dividers are visibility-aware (visibleN-1 handles between adjacent
//     VISIBLE children, patched at their ORIGINAL parts indices).
// Keeping Σfraction constant across the pair keeps Σf constant overall, which is
// exactly why every NON-adjacent column stays pixel-identical during a drag.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { CompositionTransaction, SceneNode } from '../read-data/documents';
import { resolveVisibility } from './build-visibility-binding';

/** A relative weight for one split column. The engine normalises by Σfraction. */
export type SplitPart = { fraction: number };

/** Minimum on-screen size (px) a column may be dragged to. Edit-time clamp only. */
export const MIN_COLUMN_PX = 80;

/** Default gap (px) between split columns — matches the Mobbin reference density. */
export const DEFAULT_SPLIT_GAP_PX = 12;

// ---------------------------------------------------------------------------
// 1. Build a split node (pure data — the engine lays it out)
// ---------------------------------------------------------------------------

export type MakeSplitNodeOptions = {
  /** Number of columns (clamped to ≥ 2). */
  columns: number;
  /** Main axis: 'x' = side-by-side columns (default), 'y' = stacked rows. */
  axis?: 'x' | 'y';
  /** Gap between columns in px. */
  gap?: number;
  /** Produces a fresh, unique node id (e.g. `() => 'node:' + crypto.randomUUID()`). */
  makeId: () => string;
  /** Produces one empty column child (e.g. the surface's blank flow/text node). */
  makeColumn: () => SceneNode;
};

/**
 * Build an N-column split node. Every column starts at an equal weight
 * (`fraction: 1`), so the engine renders equal columns; the divider drag then
 * redistributes weight. INVARIANT (Codex Q3): parts.length === children.length —
 * each child owns exactly one part at the same index.
 */
export function makeSplitNode(options: MakeSplitNodeOptions): SceneNode {
  const columns = Math.max(2, Math.floor(options.columns));
  const axis = options.axis ?? 'x';
  const gap = options.gap ?? DEFAULT_SPLIT_GAP_PX;
  const children: SceneNode[] = [];
  const parts: SplitPart[] = [];
  for (let i = 0; i < columns; i += 1) {
    children.push(options.makeColumn());
    parts.push({ fraction: 1 });
  }
  return {
    id: options.makeId(),
    kind: 'Container',
    props: { style: { layout: { mode: 'split', axis, gap, parts } } },
    visible: true,
    children,
  };
}

// ---------------------------------------------------------------------------
// 2. Read current parts off a node (self-describing data; tolerant)
// ---------------------------------------------------------------------------

/**
 * Read the split `parts` declared on a node's `props.style.layout` (the canonical
 * authoring location, matching insertBeside). Returns [] when the node is not a
 * split node. Tolerant of partial/garbage data (filters to finite, positive
 * fractions are NOT forced here — the engine treats ≤0 as 1.0, so we preserve
 * authored values and only coerce non-numbers to 1).
 */
export function readSplitParts(node: SceneNode | null | undefined): SplitPart[] {
  const layout = layoutOf(node);
  const raw = layout && Array.isArray((layout as Record<string, unknown>).parts)
    ? ((layout as Record<string, unknown>).parts as unknown[])
    : null;
  if (!raw) return [];
  return raw.map((p) => {
    const fraction = isRecord(p) && typeof p.fraction === 'number' && Number.isFinite(p.fraction) ? p.fraction : 1;
    return { fraction };
  });
}

/** The split node's main axis ('x' = side-by-side columns; default 'x'). */
export function readSplitAxis(node: SceneNode | null | undefined): 'x' | 'y' {
  const layout = layoutOf(node);
  const axis = layout && typeof (layout as Record<string, unknown>).axis === 'string'
    ? ((layout as Record<string, unknown>).axis as string).toLowerCase()
    : 'x';
  return axis === 'y' ? 'y' : 'x';
}

/** The split node's inter-column gap in px (default DEFAULT_SPLIT_GAP_PX). */
export function readSplitGap(node: SceneNode | null | undefined): number {
  const layout = layoutOf(node);
  const gap = layout && typeof (layout as Record<string, unknown>).gap === 'number'
    ? ((layout as Record<string, unknown>).gap as number)
    : DEFAULT_SPLIT_GAP_PX;
  return Number.isFinite(gap) && gap >= 0 ? gap : DEFAULT_SPLIT_GAP_PX;
}

/** True when the node declares `layout.mode === "split"` (case-insensitive). */
export function isSplitNode(node: SceneNode | null | undefined): boolean {
  const layout = layoutOf(node);
  const mode = layout && typeof (layout as Record<string, unknown>).mode === 'string'
    ? ((layout as Record<string, unknown>).mode as string)
    : '';
  return mode.toLowerCase() === 'split';
}

// ---------------------------------------------------------------------------
// 3. Visibility-aware divider mapping (Codex Q6)
// ---------------------------------------------------------------------------

export type DividerPair = {
  /** Original parts/children index of the column LEFT of (above) the divider. */
  leftIndex: number;
  /** Original parts/children index of the column RIGHT of (below) the divider. */
  rightIndex: number;
};

/**
 * The dividers a split node should render: one between each pair of ADJACENT
 * VISIBLE children, carrying their ORIGINAL indices. For children
 * `[A visible, B hidden, C visible]` this yields a single divider {left:0,right:2}
 * — never a handle next to the hidden column. With all children visible (today),
 * this is simply {0,1},{1,2},… With conditional visibility (future), hidden
 * columns drop out for free.
 */
export function visibleDividerPairs(children: ReadonlyArray<{ visible?: unknown }> | null | undefined): DividerPair[] {
  if (!children || children.length === 0) return [];
  const visibleIndices: number[] = [];
  children.forEach((child, index) => {
    // SAME rule the engine uses (resolveVisibility = Visibility::as_bool): a
    // bound-hidden column (visible binding resolving to its default false) is
    // skipped, so no divider renders for a column the engine collapses.
    if (resolveVisibility(child?.visible)) visibleIndices.push(index);
  });
  const pairs: DividerPair[] = [];
  for (let k = 0; k < visibleIndices.length - 1; k += 1) {
    pairs.push({ leftIndex: visibleIndices[k], rightIndex: visibleIndices[k + 1] });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// 4. Divider drag → new parts (Codex-corrected math)
// ---------------------------------------------------------------------------

export type SplitDividerDrag = {
  parts: ReadonlyArray<SplitPart>;
  /** Original parts index of the column left/above the dragged divider. */
  leftIndex: number;
  /** Original parts index of the column right/below the dragged divider. */
  rightIndex: number;
  /** Pixels the pointer moved along the main axis (right/down positive). */
  deltaPx: number;
  /** Parent main-axis content size AFTER gaps removed: available = parentMain - gap*(visibleN-1). */
  availableMainPx: number;
  /** Minimum on-screen column size (px). Defaults to MIN_COLUMN_PX. */
  minColumnPx?: number;
};

/**
 * Resize exactly the two columns flanking one divider by a pixel drag, returning
 * a NEW parts array (pure; never mutates the input). Σfraction is held constant
 * (only the pair is redistributed), so every other column stays pixel-identical.
 *
 * Math (Codex-converged): the engine sizes a column as `available * f/Σf`, hence
 *   Δf      = deltaPx * Σf / available     (NOT deltaPx/available)
 *   minPart = minPx   * Σf / available
 *   pair    = f_left + f_right             (captured BEFORE mutation)
 *   f_left' = clamp(f_left + Δf, minPart, pair - minPart)
 *   f_right'= pair - f_left'
 * If the pair cannot hold two min columns, or inputs are degenerate, the parts
 * are returned unchanged.
 */
export function applySplitDividerDrag(drag: SplitDividerDrag): SplitPart[] {
  const next = drag.parts.map((p) => ({ fraction: p.fraction }));
  const { leftIndex, rightIndex, deltaPx, availableMainPx } = drag;
  const minColumnPx = drag.minColumnPx ?? MIN_COLUMN_PX;

  if (
    leftIndex < 0 ||
    rightIndex < 0 ||
    leftIndex >= next.length ||
    rightIndex >= next.length ||
    leftIndex === rightIndex ||
    availableMainPx <= 0
  ) {
    return next;
  }

  // Σfraction over positive weights (the engine ignores ≤0 by treating it as 1.0,
  // but authored splits are always positive; we sum the positive weights for the
  // px↔fraction scale).
  const totalParts = next.reduce((sum, part) => sum + (part.fraction > 0 ? part.fraction : 0), 0);
  if (totalParts <= 0) return next;

  const a = next[leftIndex].fraction;
  const b = next[rightIndex].fraction;
  const pair = a + b;
  if (pair <= 0) return next;

  const deltaFraction = (deltaPx * totalParts) / availableMainPx;
  const minPart = (minColumnPx * totalParts) / availableMainPx;

  // The pair must be able to hold two minimum columns; otherwise the divider has
  // no room to move (e.g. a very narrow parent) and we leave the split untouched.
  if (pair < minPart * 2) return next;

  const nextA = clamp(a + deltaFraction, minPart, pair - minPart);
  next[leftIndex] = { fraction: nextA };
  next[rightIndex] = { fraction: pair - nextA };
  return next;
}

// ---------------------------------------------------------------------------
// 4b. Divider screen rects (pure positioning from engine frames)
// ---------------------------------------------------------------------------

export type FrameRect = { x: number; y: number; w: number; h: number };

export type SplitDividerRect = DividerPair & {
  /** Position RELATIVE to the split node's own frame (px, zoom=1). */
  left: number;
  top: number;
  width: number;
  height: number;
};

export type SplitDividerLayoutInput = {
  /** The split node's engine frame (stage-absolute px). */
  splitRect: FrameRect;
  /** Each column child's engine frame, indexed by ORIGINAL child index (null = unplaced). */
  childRects: ReadonlyArray<FrameRect | null | undefined>;
  /** Visible adjacencies (from visibleDividerPairs) carrying original indices. */
  pairs: ReadonlyArray<DividerPair>;
  axis: 'x' | 'y';
  /** Divider hit-area thickness in px (default 12). */
  thickness?: number;
};

/**
 * Where to draw each divider, RELATIVE to the split node's own SceneFrame (which
 * is absolutely positioned at the split rect). A divider sits at the midpoint of
 * the gap between its two flanking columns and spans the cross axis. Engine frames
 * are stage pixels at zoom=1, and the split frame is the positioned ancestor, so
 * `boundaryAbsolute - splitRect.origin` is the correct in-frame offset — the exact
 * coordinate convention SceneResizeHandles uses. Pure: a function of the frames.
 */
export function splitDividerScreenRects(input: SplitDividerLayoutInput): SplitDividerRect[] {
  const { splitRect, childRects, pairs, axis } = input;
  const thickness = input.thickness ?? 12;
  const out: SplitDividerRect[] = [];
  for (const pair of pairs) {
    const left = childRects[pair.leftIndex];
    const right = childRects[pair.rightIndex];
    if (!left || !right) continue;
    if (axis === 'x') {
      const boundaryAbs = (left.x + left.w + right.x) / 2;
      out.push({
        leftIndex: pair.leftIndex,
        rightIndex: pair.rightIndex,
        left: boundaryAbs - splitRect.x - thickness / 2,
        top: 0,
        width: thickness,
        height: splitRect.h,
      });
    } else {
      const boundaryAbs = (left.y + left.h + right.y) / 2;
      out.push({
        leftIndex: pair.leftIndex,
        rightIndex: pair.rightIndex,
        left: 0,
        top: boundaryAbs - splitRect.y - thickness / 2,
        width: splitRect.w,
        height: thickness,
      });
    }
  }
  return out;
}

/**
 * The main-axis space available to distribute among columns: the split's main
 * size minus the inter-column gaps (the engine subtracts total gap BEFORE
 * normalising fractions, so the divider drag must use the same available size).
 */
export function splitAvailableMainPx(splitRect: FrameRect, axis: 'x' | 'y', gap: number, visibleColumns: number): number {
  const main = axis === 'x' ? splitRect.w : splitRect.h;
  const gaps = gap * Math.max(0, visibleColumns - 1);
  return Math.max(0, main - gaps);
}

// ---------------------------------------------------------------------------
// 5. The UPDATE_PROPS transaction (full-props spread, like the resize path)
// ---------------------------------------------------------------------------

export type BuildSplitDividerTransactionInput = {
  nodeId: string;
  /** The new parts array (from applySplitDividerDrag). */
  parts: ReadonlyArray<SplitPart>;
  /** The node's CURRENT props (propsForNode) — preserved; only layout.parts changes. */
  existingProps: Record<string, unknown> | undefined;
};

/**
 * Build the engine transaction that writes the new split `parts` back. UPDATE_PROPS
 * REPLACES props wholesale (the engine does not deep-merge), so we spread the
 * existing props → existing style → existing layout and override ONLY `parts`.
 * Idempotent: re-sending the same parts is a converging no-op.
 */
export function buildSplitDividerTransaction(input: BuildSplitDividerTransactionInput): CompositionTransaction {
  const existingProps = isRecord(input.existingProps) ? input.existingProps : {};
  const existingStyle = isRecord(existingProps.style) ? existingProps.style : {};
  const existingLayout = isRecord(existingStyle.layout) ? existingStyle.layout : {};
  const nextProps: Record<string, unknown> = {
    ...existingProps,
    style: {
      ...existingStyle,
      layout: {
        ...existingLayout,
        mode: 'split',
        parts: input.parts.map((p) => ({ fraction: p.fraction })),
      },
    },
  };
  return {
    scene_patches: [{ type: 'UPDATE_PROPS', node_id: input.nodeId, changes: { props: nextProps } }],
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function layoutOf(node: SceneNode | null | undefined): unknown {
  if (!node) return null;
  const props = isRecord(node.props) ? node.props : null;
  const propStyle = props && isRecord(props.style) ? props.style : null;
  const fromProps = propStyle && isRecord(propStyle.layout) ? propStyle.layout : null;
  if (fromProps) return fromProps;
  // tolerate a top-level style.layout (legacy authoring location)
  const topStyle = isRecord(node.style) ? node.style : null;
  return topStyle && isRecord(topStyle.layout) ? topStyle.layout : null;
}

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(Math.max(value, lo), hi);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
