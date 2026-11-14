// packages/ui/show/canvas-viewport/marquee.ts
//
// =============================================================================
// PURPOSE — the generic marquee hit-test (P1 producer for any canvas)
// =============================================================================
//
// "Which addressed nodes fall inside this drag rectangle?" — answered once, for
// EVERY canvas, with zero domain vocabulary. It works purely off the DOM: every
// interactable object stamps `data-node-ref` (NODE_REF_ATTR, the universal
// addressed-handle contract from node-actions/node-ref.ts), so the marquee finds
// them by attribute, reads their on-screen rectangles, and intersects.
//
// Because it is screen-space (getBoundingClientRect), it is correct under any
// pan/zoom/transform the surface applies — the browser already composes the
// world transform into the client rect. The caller never converts coordinates.
//
// A board, a workflow canvas, a screen-arrangement — all marquee-select through
// THIS function. New canvases get marquee for free the moment their nodes stamp
// the attribute. No per-canvas hit-testing code ever again.
// =============================================================================

import type { NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';
import { NODE_REF_ATTR, parseNodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';

/** A rectangle in viewport-CLIENT pixels (same space as getBoundingClientRect). */
export interface ClientRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Build a normalized client rect from two pointer positions (drag start → now). */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): ClientRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** Do two client rects overlap at all? (touch counts as hit; marquee selects on grazing.) */
export function rectsIntersect(a: ClientRect, b: ClientRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export interface RefsInRectOptions {
  /** When set, only nodes whose `family` is in this set are eligible (e.g. only
   *  'board-item', never a toolbar chrome node that also stamps a ref). */
  readonly families?: ReadonlySet<string>;
  /** Require full containment instead of intersection (Figma-style "window" select). */
  readonly contain?: boolean;
}

/** Containment test: is `inner` fully inside `outer`? */
function rectContains(outer: ClientRect, inner: ClientRect): boolean {
  return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
}

/**
 * Every `[data-node-ref]` element inside `root` whose on-screen rectangle the
 * marquee rect hits. `rect` is in client pixels (e.g. from pointer clientX/clientY).
 * Returns parsed NodeRefs, deduped by serialization-identity preserved by the
 * caller's selection Set.
 */
export function refsInRect(root: HTMLElement, rect: ClientRect, opts?: RefsInRectOptions): NodeRef[] {
  const hits: NodeRef[] = [];
  const nodes = root.querySelectorAll<HTMLElement>(`[${NODE_REF_ATTR}]`);
  for (const el of Array.from(nodes)) {
    const ref = parseNodeRef(el.getAttribute(NODE_REF_ATTR));
    if (!ref) continue;
    if (opts?.families && !opts.families.has(ref.family)) continue;
    const box = el.getBoundingClientRect();
    const nodeRect: ClientRect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    const hit = opts?.contain ? rectContains(rect, nodeRect) : rectsIntersect(rect, nodeRect);
    if (hit) hits.push(ref);
  }
  return hits;
}
