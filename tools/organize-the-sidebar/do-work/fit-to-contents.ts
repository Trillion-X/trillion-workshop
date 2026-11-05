// packages/group/do-work/fit-to-contents.ts
//
// FIT-A-FRAME-TO-ITS-CONTENTS — the generative primitive behind "make this container wrap exactly what it
// holds" (the Miro/FigJam frame-resize canon), DECOUPLED from how the container finds its children so it
// serves BOTH a spatial frame AND a membership `isSection` group. A section is a world-space rectangle
// around child items whose coordinates are world-absolute (dropping an item into a section re-parents it
// but never moves it), so containing them is pure geometry over the child rects.
//
// It reuses the canonical bounding-box SSOT `selectionBounds` (group-resize) — the SAME union `frameFitBox`
// and `createFrameFromSelection` use — and only ADDS what those lack: an extra `headerHeight` reserved at
// the TOP (a section draws its title there, so contents must not slide under it) and a `growOnly` union
// with the current rect (so an auto-grow-on-drag hook can EXPAND a frame to swallow a card dragged past its
// edge without ever snapping it smaller). `frameFitBox` is the spatial-frame special case of this primitive
// (exact fit, no header); this is the general one. Pure leaf (zero I/O).

import { selectionBounds, type Rect } from './group-resize.ts';

export type FitRect = Rect;

export interface FitOptions {
  /** Uniform inset kept on all four sides around the children (default 24). */
  readonly padding?: number;
  /** Extra space reserved at the TOP for a section's title bar (default 0). */
  readonly headerHeight?: number;
  /** When true, the result is UNIONED with `current` — it only ever grows (never shrinks). Default false
   *  (exact fit). */
  readonly growOnly?: boolean;
}

const DEFAULT_PADDING = 24;

/**
 * The rectangle that snugly contains every child (inset by `padding`, plus `headerHeight` at the top).
 * Empty `children` → `current` unchanged (nothing to fit — never collapse a frame to a point). With
 * `growOnly`, the returned rect is the union with `current`, so it can only expand.
 */
export function fitRectToContents(current: FitRect, children: readonly FitRect[], opts?: FitOptions): FitRect {
  const bounds = selectionBounds(children);
  if (!bounds) return current;
  const padding = opts?.padding ?? DEFAULT_PADDING;
  const header = opts?.headerHeight ?? 0;
  const exact: FitRect = {
    x: bounds.x - padding,
    y: bounds.y - padding - header,
    w: bounds.w + 2 * padding,
    h: bounds.h + 2 * padding + header,
  };
  if (!opts?.growOnly) return exact;
  const x = Math.min(current.x, exact.x);
  const y = Math.min(current.y, exact.y);
  const right = Math.max(current.x + current.w, exact.x + exact.w);
  const bottom = Math.max(current.y + current.h, exact.y + exact.h);
  return { x, y, w: right - x, h: bottom - y };
}

/** True iff `current` does NOT already contain every child with the given insets — i.e. a grow is needed.
 *  Lets an auto-grow hook skip a no-op patch (and its undo entry) when the frame already fits. */
export function needsGrow(current: FitRect, children: readonly FitRect[], opts?: FitOptions): boolean {
  if (children.length === 0) return false;
  const grown = fitRectToContents(current, children, { ...opts, growOnly: true });
  return grown.x !== current.x || grown.y !== current.y || grown.w !== current.w || grown.h !== current.h;
}
