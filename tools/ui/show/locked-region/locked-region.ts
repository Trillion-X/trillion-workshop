// parts/ui/show/locked-region/locked-region.ts
//
// PURPOSE
//   The one answer to "is this place locked?". A locked region is an element carrying `data-locked`: inside it only
//   the region's own controls act. Any layer that works across the whole page (answering selected words, pointing at
//   things, zooming or panning an arrangement, anything added later) asks `isLockedAt` about the node its event is on
//   and does nothing there, so a locked screen stays locked without anyone listing which layers to switch off.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a layer, a screen or a reason for locking; whoever locks marks the region.
//   2. A node is locked when it or any ancestor carries `data-locked` (nested regions need no special case); text
//      nodes are judged by their parent element; anything that is not a node is never locked.
//   3. Reading has no side effects and keeps no state.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The attribute that marks a locked region. */
export const LOCKED_ATTRIBUTE = 'data-locked';

/** True when `node` is inside a locked region (invariant 2). */
export function isLockedAt(node: unknown): boolean {
  if (typeof Node === 'undefined' || !(node instanceof Node)) return false;
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest(`[${LOCKED_ATTRIBUTE}]`));
}
