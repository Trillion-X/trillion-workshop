// packages/ui/show/step-progress/step-progress.ts
//
// PURPOSE
// The progress projection (engine mechanism M6) for the guided-overlay
// walkthrough. Two parts, both first-principles:
//   1. PURE projection: `progressState(cursorIndex, total)` → the universal
//      progress facts (current/total/ratio/first/last). Independent of how it's
//      drawn — a counter, dots, a bar, and segments all read the SAME state.
//   2. BLIND style registry: `progress_style.style` is an OPEN string dispatched
//      through the shared `blind-registry` (counter|dots|bar|segmented|<future>),
//      never `switch(style)`. A new progress visual = one `register()` + zero
//      change here. The style is DATA; the projection is Physics.

import { createBlindRegistry, type BlindRegistry } from '../blind-registry/blind-registry';

/** Universal progress facts — what every progress visual reads. */
export interface ProgressState {
  /** 0-based cursor position (clamped into range). */
  readonly index: number;
  /** 1-based current step number (0 when there are no steps). */
  readonly current: number;
  /** Total step count. */
  readonly total: number;
  /** Completion ratio in [0,1] (`current/total`). */
  readonly ratio: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/** Derive the universal progress facts from a cursor + step count. Pure. */
export function progressState(cursorIndex: number, total: number): ProgressState {
  const safeTotal = Math.max(0, Math.floor(total));
  if (safeTotal === 0) {
    return { index: 0, current: 0, total: 0, ratio: 0, isFirst: true, isLast: true };
  }
  const index = clamp(Math.floor(cursorIndex), 0, safeTotal - 1);
  const current = index + 1;
  return {
    index,
    current,
    total: safeTotal,
    ratio: current / safeTotal,
    isFirst: index === 0,
    isLast: index === safeTotal - 1,
  };
}

/**
 * Per-segment fill states for dotted/segmented visuals — `true` for steps at or
 * before the cursor. Derived from the same state, so dots and segments never
 * disagree with the counter or bar.
 */
export function segmentFills(state: ProgressState): boolean[] {
  return Array.from({ length: state.total }, (_, i) => i <= state.index);
}

/** A progress visual renderer — opaque to this module (a React component or fn). */
export type ProgressStyleRenderer<R> = R;

/** A blind registry of progress visuals keyed by raw `progress_style.style`. */
export type StepProgressRegistry<R> = BlindRegistry<R>;

/**
 * Create a progress-style registry. `fallback` renders when a DATA author names a
 * style nobody registered (L083). Delegates to the shared blind-registry — no
 * second Map, no `switch(style)`.
 */
export function createStepProgressRegistry<R>(fallback: R): StepProgressRegistry<R> {
  return createBlindRegistry<R>({ fallback });
}
