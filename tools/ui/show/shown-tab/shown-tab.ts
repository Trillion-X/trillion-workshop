// tools/ui/show/shown-tab/shown-tab.ts
//
// PURPOSE
//   The id of the tab a person is looking at in the workspace (the active tab of the focused pane). The workspace's
//   arrangement publishes it; the sidebar reads it so the row of the open screen is the one highlighted. A tab's id is
//   its screen's row id, so the sidebar matches it directly.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One value for the whole page: a publish replaces the last, and every reader sees the same id.
//   2. A publish of the id already held changes nothing, so readers never redraw for the same tab.

import { useSyncExternalStore } from 'react';

type Listener = () => void;

let shown: string | null = null;
const listeners = new Set<Listener>();

/** Says which tab is shown now (null when none is). */
export function publishShownTab(tabId: string | null): void {
  if (tabId === shown) return;
  shown = tabId;
  for (const listener of listeners) listener();
}

/** Calls `listener` when the shown tab changes; returns the call that stops it. */
export function subscribeShownTab(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The tab shown now. */
export function readShownTab(): string | null {
  return shown;
}

/** The tab shown now, read in a React screen and drawn again when it changes. */
export function useShownTab(): string | null {
  return useSyncExternalStore(subscribeShownTab, readShownTab);
}
