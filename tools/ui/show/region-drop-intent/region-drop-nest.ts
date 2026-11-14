// packages/ui/show/region-drop-intent/region-drop-nest.ts
//
// Nest coordination for RegionDropRouter. When drop-intent routers NEST — a
// surface-root router wrapping pane routers, or (today) a freeform canvas router
// wrapping container routers — a drag over the inner region activates BOTH routers,
// so without coordination BOTH paint their drop-intent cards (double overlay; the
// outer "Set as background" card competes with the inner one). That is the
// nested-overlay bug the deferred surface-backdrop drop was blocked on.
//
// The rule (the deferred fix's named primitive): only the INNERMOST active region
// renders its overlay. This is a pure, shared store: each active router CLAIMS its
// nesting depth; a router paints its overlay only when its depth is the deepest
// currently claimed. The store is created once by the OUTERMOST router and shared
// (via context) by every nested router, so they agree on the max active depth.
//
// Pure: a Map of depth→active-count + a listener set. No React, no DOM — unit
// testable in isolation; the router binds it with useSyncExternalStore.

import * as React from 'react';

export interface RegionDropNestStore {
  /** Mark a router at `depth` active (a drag is over its region). Refcounted so
   *  re-entrancy / two regions at the same depth are both honored. */
  claim(depth: number): void;
  /** Mark a router at `depth` no longer active. */
  release(depth: number): void;
  /** The deepest currently-claimed depth, or -1 when none is active. */
  maxActiveDepth(): number;
  /** Subscribe to changes (for useSyncExternalStore). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createRegionDropNestStore(): RegionDropNestStore {
  const counts = new Map<number, number>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    claim(depth) {
      counts.set(depth, (counts.get(depth) ?? 0) + 1);
      emit();
    },
    release(depth) {
      const next = (counts.get(depth) ?? 0) - 1;
      if (next <= 0) counts.delete(depth);
      else counts.set(depth, next);
      emit();
    },
    maxActiveDepth() {
      let max = -1;
      for (const depth of counts.keys()) if (depth > max) max = depth;
      return max;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What a RegionDropRouter shares with the routers nested inside it: the ONE shared
 *  store + this router's own depth (a child router's depth is this + 1). Absent
 *  context = this router is the outermost (depth 0) and owns a fresh store. */
export interface RegionDropNestContextValue {
  readonly store: RegionDropNestStore;
  readonly depth: number;
}

export const RegionDropNestContext = React.createContext<RegionDropNestContextValue | null>(null);
