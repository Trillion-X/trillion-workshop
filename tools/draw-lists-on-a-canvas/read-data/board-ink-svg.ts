// packages/addressed-marks/read-data/board-ink-svg.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The PUBLIC, decoupled "ink → export overlay" reader, OWNED by addressed-marks
// (the package that owns the ink representation). A consumer that wants to embed
// the live ink in its OWN export (e.g. the group board's SVG/PNG export) calls
// `boardInkToSvg(...)` and receives an OPAQUE `{ svg, bounds }` fragment. The
// consumer never imports `materializeMarkRecords`, `marksToSvg`, or operation
// internals — the decoupling contract (no god package, L090): the board is BLIND
// to stroke structure, it only composites the returned fragment.
//
// This mirrors AddressedMarkOverlay's on-screen pipeline EXACTLY so an export
// looks identical to the canvas:
//   feed operations  (useMarkOperations — current log state)
//   + session optimistic operations  (drawn this session, not yet in the feed)
//   → materializeMarkRecords (filters to the target, resolves styles, hides erased)
//   → marksToSvg (serialize visible paths to an SVG stroke fragment + world bounds)
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import {
  materializeMarkRecords,
  markTargetKey,
  type MarkOperationRecord,
  type MarkStyleRecord,
  type MarkTarget,
} from './addressed-marks';
import {
  marksToSvg,
  type MarksSvgResult,
  type MarksToSvgOptions,
} from './marks-to-svg';

export interface BoardInkToSvgArgs {
  /** Operations from the live log feed (useMarkOperations). */
  readonly feedOperations: readonly MarkOperationRecord[];
  /** Operations drawn THIS session, possibly not yet round-tripped to the feed. */
  readonly optimisticOperations?: readonly MarkOperationRecord[];
  /** Mark styles from the live feed (useMarkStyles). */
  readonly styles?: readonly MarkStyleRecord[];
  /** The mark target scoping the ink (e.g. boardWorldMarkTarget(boardId)). */
  readonly target: MarkTarget;
  /** Serializer options (e.g. defaultStroke). */
  readonly options?: MarksToSvgOptions;
}

/**
 * Merge the live feed with the session's optimistic operations for a target, exactly as
 * AddressedMarkOverlay does: optimistic ops are kept only when they are NOT already in the
 * feed (dedup by id) AND they belong to this target. Feed ops are passed through unfiltered —
 * `materializeMarkRecords` does the authoritative target filtering downstream.
 */
export function resolveTargetMarkOperations(args: {
  readonly feedOperations: readonly MarkOperationRecord[];
  readonly optimisticOperations?: readonly MarkOperationRecord[];
  readonly target: MarkTarget;
}): readonly MarkOperationRecord[] {
  const { feedOperations, optimisticOperations = [], target } = args;
  if (optimisticOperations.length === 0) return feedOperations;
  const feedIds = new Set(feedOperations.map((operation) => operation.id));
  const targetKey = markTargetKey(target);
  const optimistic = optimisticOperations.filter(
    (operation) => !feedIds.has(operation.id) && markTargetKey(operation.target) === targetKey,
  );
  return optimistic.length === 0 ? feedOperations : [...feedOperations, ...optimistic];
}

/**
 * Serialize the CURRENT visible ink for `target` to an opaque SVG overlay fragment + world
 * bounds. Returns `{ svg: '', bounds: null }` when there is no ink, so a consumer can skip
 * the overlay entirely (no empty `<g>`/viewBox expansion).
 */
export function boardInkToSvg(args: BoardInkToSvgArgs): MarksSvgResult {
  const operations = resolveTargetMarkOperations(args);
  const material = materializeMarkRecords({ operations, styles: args.styles, target: args.target });
  return marksToSvg(material, args.options);
}
