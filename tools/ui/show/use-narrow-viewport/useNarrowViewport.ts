//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE shared answer to "is this screen phone-narrow?" — a media-query hook so
// every surface stacks list/detail/tab layouts the same way at the same
// breakpoint. The breakpoint is a parameter (Society data at the call site),
// defaulting to the shared phone width.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Subscribes via matchMedia — no resize polling, updates on change only.
// 2. SSR/headless-safe: with no matchMedia, reports false (desktop layout).
// 3. The hook and the one-shot read (`viewportIsNarrow`) ask the same query.
//
// =============================================================================

import { useMediaQuery } from '../use-media-query/use-media-query';

export const PHONE_MAX_WIDTH_PX = 640;

function narrowViewportQuery(maxWidthPx: number): string {
  return `(max-width: ${maxWidthPx}px)`;
}

export function useNarrowViewport(maxWidthPx: number = PHONE_MAX_WIDTH_PX): boolean {
  return useMediaQuery(narrowViewportQuery(maxWidthPx));
}

/** The same answer read once, for code that runs on an action rather than on render (opening a screen). */
export function viewportIsNarrow(maxWidthPx: number = PHONE_MAX_WIDTH_PX): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.(narrowViewportQuery(maxWidthPx)).matches ?? false);
}
