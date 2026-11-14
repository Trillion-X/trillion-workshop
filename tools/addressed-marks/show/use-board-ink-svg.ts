// packages/addressed-marks/show/use-board-ink-svg.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// PUBLIC hook a consumer mounts to get a STABLE getter that, when called at
// export-click time, serializes the CURRENT visible ink for a target into an
// OPAQUE `{ svg, bounds }` overlay fragment. The consumer (e.g. the group board
// export) never touches ink internals — it receives a finished fragment and
// composites it (the decoupling contract, no god package).
//
// It reads the SAME live sources AddressedMarkOverlay renders from —
// `useMarkOperations()` (current log feed) + the session's optimistic
// operations — so an export matches the canvas. The getter is a memoized
// callback: mount it once near the top of a component, stash `.current` in a
// ref, and call it inside any export handler (handlers can't call hooks).
//
// NOTE: a consumer cannot see another component's PRIVATE React state, so the
// few-hundred-ms-fresh strokes that live only in the drawing overlay's local
// buffer are not visible here. That is correct decoupling: the cross-component
// SSOT is the feed + session, and by the time a user clicks Export any stroke
// has propagated to one of them.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import React from 'react';
import { boardInkToSvg } from '../read-data/board-ink-svg';
import type { MarksSvgResult, MarksToSvgOptions } from '../read-data/marks-to-svg';
import type { MarkOperationRecord, MarkTarget } from '../read-data/addressed-marks';
import { useMarkOperations, useMarkStyles } from './use-mark-data';
import { useMarkSession } from './MarkSessionContext';

const NO_OPTIMISTIC: readonly MarkOperationRecord[] = [];

/**
 * Returns a stable getter `() => { svg, bounds }` serializing the current visible ink for
 * `target`. Returns `{ svg: '', bounds: null }` when there is no ink, so the consumer can
 * skip the overlay entirely. Reads `useMarkOperations()` + the session's optimistic ops.
 */
export function useBoardInkSvgReader(
  target: MarkTarget,
  options?: MarksToSvgOptions,
): () => MarksSvgResult {
  const feedOperations = useMarkOperations();
  const styles = useMarkStyles();
  const session = useMarkSession();
  const optimisticOperations = session?.optimisticOperations ?? NO_OPTIMISTIC;
  return React.useCallback(
    () => boardInkToSvg({ feedOperations, optimisticOperations, styles, target, options }),
    [feedOperations, styles, optimisticOperations, target, options],
  );
}
