// parts/ui/show/choice-tiles/remembered-choice.ts
//
// PURPOSE
//   What the person last chose among a set of tiles (which AI app they use, say), kept on this computer so every place
//   that offers the same choice opens on it: the tiles start on it and a button that goes to the choice names it. It is
//   kept twice: in this browser's storage for the page, and in a cookie a server-drawn page reads (a failure page has no
//   script to ask the storage).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The part names no choice: `key` and the ids are the caller's DATA.
//   2. A choice made in one place is seen at once by every other place on the page (one event), and by the next page.
//   3. Storage that refuses (a private window, a blocked cookie) never breaks a press: the choice holds for the page.

import React from 'react';
import { accountKey } from '../page-storage/page-storage';

const STORAGE = (key: string) => `trillion.choice.${key}`;
/** The cookie a server page reads a remembered choice from (src/ask-your-ai.mjs reads `trillion_choice_ai`). */
export const choiceCookie = (key: string) => `trillion_choice_${key}`;
const CHANGED = 'trillion:remembered-choice';
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const held = new Map<string, string>();

/** The id last chosen under `key`, or null. */
export function rememberedChoice(key: string): string | null {
  if (held.has(key)) return held.get(key) ?? null;
  try {
    const name = accountKey(STORAGE(key));
    return name ? localStorage.getItem(name) : null;
  } catch { return null; }
}

/** Remembers `id` as the choice under `key`, here and for the next page. Kept for the signed-in account only: with no
 *  account signed in on the page, the choice holds for the page and is not written to the device. */
export function rememberChoice(key: string, id: string): void {
  held.set(key, id);
  try {
    const name = accountKey(STORAGE(key));
    if (name) localStorage.setItem(name, id);
  } catch { /* the page holds it */ }
  try { document.cookie = `${choiceCookie(key)}=${encodeURIComponent(id)}; path=/; max-age=${YEAR_SECONDS}; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`; } catch { /* the page holds it */ }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { key, id } }));
}

/** The choice under `key`, kept current as it changes anywhere on the page, and a way to change it. */
export function useRememberedChoice(key: string): [string | null, (id: string) => void] {
  const [id, setId] = React.useState(() => rememberedChoice(key));
  React.useEffect(() => {
    const changed = (event: Event) => { const detail = (event as CustomEvent<{ key: string; id: string }>).detail; if (detail?.key === key) setId(detail.id); };
    window.addEventListener(CHANGED, changed);
    return () => window.removeEventListener(CHANGED, changed);
  }, [key]);
  return [id, React.useCallback((next: string) => rememberChoice(key, next), [key])];
}
