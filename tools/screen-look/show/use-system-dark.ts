// parts/screen-look/show/use-system-dark.ts
//
// PURPOSE
//   Whether the computer's own appearance setting is dark right now, and a change of it as it happens. Read only for the
//   person's Automatic theme mode (read-data/look-follow-system.ts); no look otherwise follows it, and the stylesheets
//   still never answer prefers-color-scheme (coss-workspace.css).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A page with no way to ask (no matchMedia) is light, never a guess from the clock.

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-color-scheme: dark)';
const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null);

function subscribe(listener: () => void): () => void {
  const media = query();
  media?.addEventListener('change', listener);
  return () => media?.removeEventListener('change', listener);
}

export const useSystemDark = (): boolean => useSyncExternalStore(subscribe, () => query()?.matches === true, () => false);
