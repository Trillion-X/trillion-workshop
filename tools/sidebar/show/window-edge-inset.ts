// tools/sidebar/show/window-edge-inset.ts
//
// PURPOSE
//   Where a window-level sidebar frame (or bar) stands from one window edge. Such a frame is portalled into document.body,
//   outside the workspace's safe box, so it keeps its gap from the window's edge PLUS that edge's safe area (status bar, notch,
//   home indicator; 0 everywhere else). The top and bottom also follow the visible area (bind-visible-viewport), as the
//   workspace does: while a keyboard is up the bottom sits above the keyboard and its typing bar, and the home indicator's safe
//   area under the keyboard no longer counts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The bottom stands clear of what the page keeps at its own bottom: while the cookie bar shows it measures itself into
//      --consent-banner-reserve (tools/ui/show/consent-banner), and the frame ends above it. The bar's height already holds the
//      home indicator's safe area, so the larger of the two counts, never both.
//   2. Only CSS: the browser works the values out, so a bar that grows, closes or a keyboard that rises moves the frame at once.

export type WindowEdge = 'top' | 'bottom' | 'left' | 'right';

/** The CSS length a window-level frame stands from `edge`, `gap` pixels clear of what sits there. */
export function windowEdgeInset(edge: WindowEdge, gap: number): string {
  if (edge === 'top') return `calc(var(--visible-viewport-top, 0px) + env(safe-area-inset-top) + ${gap}px)`;
  if (edge === 'bottom') {
    return `calc(var(--visible-viewport-bottom, 0px) + max(env(safe-area-inset-bottom) * (1 - var(--visible-viewport-keyboard, 0)), var(--consent-banner-reserve, 0px)) + ${gap}px)`;
  }
  return `calc(env(safe-area-inset-${edge}) + ${gap}px)`;
}
