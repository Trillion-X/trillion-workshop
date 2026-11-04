// parts/sidebar/read-data/live-graph.ts
//
// NO PRIOR: Trillion's own (lists a rule fills change while the page is open).
//
// PURPOSE
//   A caller-projected list graph that the caller may replace while the page is open: lists filled by a rule (what is
//   new, what a rule picks out) change when the facts they read change or when the clock passes a moment one of their
//   rules names. The caller hands every reader the same first graph and later replaces it here; each reader of that
//   graph (the sidebar, an empty pane's Folders) follows the newest one.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A graph is followed by the identity of the first graph the caller handed out; a graph never replaced reads as
//      itself, so a caller that never replaces anything sees no change.
//   2. Replacing with an equal graph (same JSON) wakes no reader.

import * as React from 'react';

type Followed = { graph: unknown; text: string; listeners: Set<() => void> };
const followed = new WeakMap<object, Followed>();

const entryOf = (first: object): Followed => {
  let entry = followed.get(first);
  if (!entry) { entry = { graph: first, text: JSON.stringify(first), listeners: new Set() }; followed.set(first, entry); }
  return entry;
};

/** Hand every reader of `first` the graph `next` from now on. */
export function replaceProjectedGraph(first: object, next: unknown): void {
  const entry = entryOf(first);
  const text = JSON.stringify(next);
  if (text === entry.text) return;
  entry.graph = next;
  entry.text = text;
  for (const listener of entry.listeners) listener();
}

/** The newest graph handed out in place of `first` (itself when `first` is not an object or was never replaced). */
export function useProjectedGraph(first: unknown): unknown {
  const subscribe = React.useCallback((listener: () => void) => {
    if (!first || typeof first !== 'object') return () => {};
    const entry = entryOf(first);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [first]);
  const read = React.useCallback(() => (first && typeof first === 'object' ? entryOf(first).graph : first), [first]);
  return React.useSyncExternalStore(subscribe, read, read);
}
