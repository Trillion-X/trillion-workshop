// parts/ui/show/page-backdrop/page-backdrop.ts
//
// PURPOSE
//   Whether the page has something moving behind all of it (the whole workspace's background: behind the sidebar, the
//   panes and every screen), and whether the page has finished opening. The one owner of the page's background
//   (screen-arrangement's root arrangement) says what it shows; the page says once it is open; the look painter
//   (screen-look) reads both and lets the background show through its surfaces only while both hold, so nothing shows
//   through while the page is still opening and its own opening scene is on screen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: it knows only "something is behind the page" and "the page is open"; it never knows what is behind it.
//   2. Shown only once open: before markPageOpen, usePageBackdrop answers false whatever the owner said.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';

type State = { open: boolean; behind: boolean };
let state: State = { open: false, behind: false };
const listeners = new Set<() => void>();
const change = (next: State) => {
  if (next.open === state.open && next.behind === state.behind) return;
  state = next;
  listeners.forEach(listener => listener());
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const shown = () => state.open && state.behind;

/** The page has finished opening (its opening scene is gone). */
export function markPageOpen(): void { change({ ...state, open: true }); }

/** Settles once the page has finished opening, so what would cover or change the page waits for it. */
export function whenPageOpen(): Promise<void> {
  if (state.open) return Promise.resolve();
  return new Promise(done => {
    const off = subscribe(() => { if (state.open) { off(); done(); } });
  });
}

/** The page's background owner says whether something is behind the whole page now. */
export function setPageBackdrop(behind: boolean): void { change({ ...state, behind }); }

/** True while something is behind the whole page and the page is open. */
export function readPageBackdrop(): boolean { return shown(); }

/** The same, for a component, repainting when it changes. */
export function usePageBackdrop(): boolean {
  return React.useSyncExternalStore(subscribe, shown, () => false);
}
