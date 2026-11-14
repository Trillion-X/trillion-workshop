// parts/ui/show/use-media-query/use-media-query.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE live answer to "does this media query match right now?". Every screen
// question the browser already answers (phone-narrow, reduced motion, colour
// scheme, pointer kind) is this one hook with a different query string.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reads matchMedia on every snapshot and subscribes to its change event, so
//    the answer follows the person's setting the moment it changes. Nothing is
//    cached at module load.
// 2. SSR/headless-safe: with no matchMedia, reports false.
//
// =============================================================================

import React from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  const getSnapshot = React.useCallback(() => (
    typeof window !== 'undefined' && Boolean(window.matchMedia?.(query)?.matches)
  ), [query]);
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** True while the person has asked the operating system for less motion. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}
