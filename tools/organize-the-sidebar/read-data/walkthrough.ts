// packages/group/read-data/walkthrough.ts
//
// R7: a guided walkthrough is ORDERED DATA STEPS over board elements. Each step points at a
// target (a card memberId or a named chrome anchor) and carries a title + body; the overlay
// spotlights the target and shows the step. Authoring a tour is pure DATA — no code per
// tour, no code per step (L090). Within a board this is self-contained: the steps reference
// the board's own elements, so it needs no engine and no external package (the cross-APP
// `guided-overlay` owner is for tours that span the whole product, not one board).
//
// This leaf is the step model + navigation (clamped index, progress) — pure, deterministic,
// no I/O. The overlay + rect resolution live in the show layer; the controller state (which
// tour, which index) is trivial and owned by whoever mounts it.

export interface TourStep {
  readonly id: string;
  /** The element this step points at — a board card's memberId or a named chrome anchor
   *  ('toolbar.share', …). Absent → the step is shown centered, unattached. */
  readonly target?: string;
  readonly title: string;
  readonly body: string;
}

export interface Tour {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly TourStep[];
}

/** The step at `index`, or null when out of range / empty. */
export function stepAt(tour: Tour, index: number): TourStep | null {
  return tour.steps[index] ?? null;
}

/** Clamp an index into the tour's valid range (0 for an empty tour). */
export function clampIndex(tour: Tour, index: number): number {
  if (tour.steps.length === 0) return 0;
  return Math.max(0, Math.min(index, tour.steps.length - 1));
}

export function nextIndex(tour: Tour, index: number): number {
  return clampIndex(tour, index + 1);
}

export function prevIndex(tour: Tour, index: number): number {
  return clampIndex(tour, index - 1);
}

/** True when `index` is the final step (Next becomes Done). */
export function isLastStep(tour: Tour, index: number): boolean {
  return tour.steps.length === 0 || index >= tour.steps.length - 1;
}

export function isFirstStep(index: number): boolean {
  return index <= 0;
}

/** "2 of 5" — human progress for the step card. */
export function tourProgressLabel(index: number, total: number): string {
  if (total <= 0) return '';
  return `${Math.min(index + 1, total)} of ${total}`;
}
