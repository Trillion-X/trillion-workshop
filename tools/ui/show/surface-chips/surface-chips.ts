// parts/ui/show/surface-chips/surface-chips.ts
//
// PURPOSE
// A small tinted chip beside a navigation row's name ("New"), set by whoever decides it (the sidebar's lists a rule
// fills, src/workspace/sidebar-rules-live.ts). An owner publishes the whole set; any row reads the chip for its own
// id and draws it with the shared Badge. A chip may name the list it comes from (`from`), so the row drawn inside
// that list does not repeat what the list already says.
//
// NON-NEGOTIABLE INVARIANTS
// 1. One table per document (globalThis), so separately bundled scripts on one page read and write the same chips
//    (as surface-notes and surface-badges do).
// 2. Publishing the set replaces it whole; a chip absent from it is gone.
// 3. Publishing an unchanged set notifies nobody.
// 4. Nothing here names a chip's words, its tone or what it means: the publisher's DATA does.

import React from 'react';

/** A chip on one row: its words, the shared Badge's variant it is drawn in, and the list it comes from. */
export interface SurfaceChip {
  readonly label: string;
  readonly variant?: string;
  readonly from?: string;
}

type Listener = () => void;
interface ChipTable {chips: ReadonlyMap<string, SurfaceChip>; key: string; listeners: Set<Listener>}

const KEY = '__trillionSurfaceChips';

function table(): ChipTable {
  const scope = globalThis as unknown as Record<string, ChipTable | undefined>;
  return scope[KEY] ??= {chips: new Map(), key: '', listeners: new Set()};
}

/** Replace every chip (invariant 2); the same set again notifies nobody (invariant 3). */
export function publishSurfaceChips(chips: ReadonlyMap<string, SurfaceChip>): void {
  const current = table();
  const key = JSON.stringify([...chips]);
  if (current.key === key) return;
  current.chips = chips;
  current.key = key;
  for (const listener of [...current.listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  const current = table();
  current.listeners.add(listener);
  return () => { current.listeners.delete(listener); };
}

/** The chip on `id`, or undefined when there is none. */
export function useSurfaceChip(id: string | undefined): SurfaceChip | undefined {
  const read = React.useCallback(() => (id ? table().chips.get(id) : undefined), [id]);
  return React.useSyncExternalStore(subscribe, read, read);
}
