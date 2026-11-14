// packages/ui/show/edge-auto-hide/edge-auto-hide-model.ts
//
// The pure, position-aware geometry of an off-screen auto-hiding panel (U2).
// A panel docked to ANY edge (top/left/bottom/right) slides fully off-screen
// when not revealed, and a thin edge hotzone (+ the panel itself) reveals it on
// pointer-enter. This module owns ONLY the math — which axis to translate, the
// sign of the slide, the hotzone's edge geometry — so the React component and
// any future consumer share one source of truth. No React, no DOM, no I/O.
//
// Generic over the 4 edges: the edge is DATA. Lifted from the customer
// sidebar-chrome mechanism (REVEAL_HOTZONE edge sensor + slide transform),
// generalized from left/right to all four edges and decoupled from framer-motion
// + the Next.js tab-state context.

/** Which screen edge the panel docks to. Pure Society data — the model is blind to meaning. */
export type DockEdge = 'top' | 'left' | 'bottom' | 'right';

/** True when the edge runs along the X axis (left/right) vs the Y axis (top/bottom). */
export function isHorizontalEdge(edge: DockEdge): boolean {
  return edge === 'left' || edge === 'right';
}

/**
 * The CSS transform that hides (slides off-screen) or shows the panel for its
 * edge. Hidden = translated fully out by its own size on the perpendicular axis,
 * minus an optional `peekPx` sliver left on screen. Shown = identity.
 *
 * left:  hidden → translateX(calc(-100% + peek))   right: hidden → translateX(calc(100% - peek))
 * top:   hidden → translateY(calc(-100% + peek))   bottom: hidden → translateY(calc(100% - peek))
 */
export function edgeTransform(edge: DockEdge, revealed: boolean, peekPx = 0): string {
  if (revealed) return 'translate3d(0, 0, 0)';
  const axis = isHorizontalEdge(edge) ? 'X' : 'Y';
  const negative = edge === 'left' || edge === 'top';
  if (peekPx > 0) {
    // Mostly off-screen with a `peekPx` sliver still visible. `calc(-100% + Npx)`
    // (NOT `-calc(...)`, which is invalid CSS) for the negative edges.
    const expr = negative ? `calc(-100% + ${peekPx}px)` : `calc(100% - ${peekPx}px)`;
    return `translate${axis}(${expr})`;
  }
  return `translate${axis}(${negative ? '-100%' : '100%'})`;
}

/** Absolute-position style for the thin edge hotzone sensor (perpendicular thickness = `sizePx`). */
export function hotzoneStyle(edge: DockEdge, sizePx: number): Record<string, string> {
  const thickness = `${sizePx}px`;
  switch (edge) {
    case 'left':
      return { position: 'fixed', left: '0', top: '0', bottom: '0', width: thickness };
    case 'right':
      return { position: 'fixed', right: '0', top: '0', bottom: '0', width: thickness };
    case 'top':
      return { position: 'fixed', top: '0', left: '0', right: '0', height: thickness };
    case 'bottom':
      return { position: 'fixed', bottom: '0', left: '0', right: '0', height: thickness };
  }
}

/** Absolute-position anchor style for the sliding panel pinned to its edge (overlay mode). */
export function panelAnchorStyle(edge: DockEdge): Record<string, string> {
  switch (edge) {
    case 'left':
      return { position: 'fixed', left: '0', top: '0', bottom: '0' };
    case 'right':
      return { position: 'fixed', right: '0', top: '0', bottom: '0' };
    case 'top':
      return { position: 'fixed', top: '0', left: '0', right: '0' };
    case 'bottom':
      return { position: 'fixed', bottom: '0', left: '0', right: '0' };
  }
}

/**
 * Resolve whether the panel is revealed. Open when PINNED (always docked), or
 * the pointer is in the edge hotzone, or inside the panel itself. This is the
 * customer `open = pinned || hoverEdge || insideAside` rule, generalized.
 */
export function isRevealed(input: { pinned: boolean; hoveringEdge: boolean; insidePanel: boolean }): boolean {
  return input.pinned || input.hoveringEdge || input.insidePanel;
}
