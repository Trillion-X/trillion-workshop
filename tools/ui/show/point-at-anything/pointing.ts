// parts/ui/show/point-at-anything/pointing.ts
//
// PURPOSE
//   Whether the page is pointing at something now, and what was picked: one small store any control can start
//   (`startPointing`, such as a pane's ⋯ menu) and the page's one pointing host reads (`usePointing`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One store per page: every control that starts pointing and the host that shows the pick read the same value.
//   2. A pick is kept until the host lets it go (`stopPointing`), so the card about it stays while the person writes.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { useSyncExternalStore } from 'react';
import type { VisualSelectionRef } from '../public-app-editor/selection-ref';

export type Pointing = { active: boolean; picked: { selection: VisualSelectionRef; element: Element } | null };

let state: Pointing = { active: false, picked: null };
const listeners = new Set<() => void>();
const set = (next: Pointing) => { state = next; for (const listener of listeners) listener(); };

/** Start pointing: the next press on the page picks what it lands on. */
export const startPointing = () => set({ active: true, picked: null });
/** A pick: pointing stops and the pick is kept for the host's card. */
export const keepPick = (selection: VisualSelectionRef, element: Element) => set({ active: false, picked: { selection, element } });
/** Stop pointing and let any pick go. */
export const stopPointing = () => set({ active: false, picked: null });

export function usePointing(): Pointing {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
    () => state,
  );
}
