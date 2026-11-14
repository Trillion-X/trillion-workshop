// parts/ui/show/asked-now/use-asked-now.ts
//
// PURPOSE
//   Act once on an "asked now" record: a value with `asked_at` that something else (the person's AI, through their
//   store) writes to ask the open page to do a thing at once, such as start a tour or open a layout. The page is told
//   each new ask once, and an ask that was already old when the page opened is not acted on, so a reload never repeats
//   it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One ask, one action per browser: the `asked_at` acted on is kept under `storageKey` (localStorage) for the
//      signed-in account (accountKey), and the same `asked_at` is never acted on again, in this tab or after a reload.
//      Another account's mark is never read; with no account on the page the mark is kept nowhere, and the page still
//      acts on an ask once per tab.
//   2. An ask older than `freshMs` when first seen is taken as already done.
//   3. `ready` false holds the ask until the page can act on it (its choices loaded, or the person's show rules let it
//      show); it is not dropped, however long it is held, once this page saw it while it was fresh.
//   4. Blind: nothing here names what is asked; `act` gets the value as it was written.

import * as React from 'react';
import { pageStorage, accountKey } from '../page-storage/page-storage';

export type AskedNow = { readonly asked_at?: unknown } & Record<string, unknown>;

function seenAt(storageKey: string): string | null {
  const key = accountKey(storageKey);
  try { return key ? pageStorage()?.getItem(key) ?? null : null; } catch { return null; }
}
function markSeen(storageKey: string, at: string) {
  const key = accountKey(storageKey);
  try { if (key) pageStorage()?.setItem(key, at); } catch { /* a browser that keeps nothing still acts once per tab */ }
}

export function useAskedNow(value: unknown, storageKey: string, act: (asked: AskedNow) => void, ready = true, freshMs = 120_000): void {
  const handled = React.useRef<string | null>(null);
  // The ask last seen while still fresh: one held by `ready` stays this page's to act on however long it is held.
  const seenFresh = React.useRef<string | null>(null);
  const actRef = React.useRef(act);
  actRef.current = act;
  React.useEffect(() => {
    const asked = value && typeof value === 'object' ? (value as AskedNow) : null;
    const at = typeof asked?.asked_at === 'string' ? asked.asked_at : null;
    if (!asked || !at || handled.current === at || seenAt(storageKey) === at) return;
    if (seenFresh.current !== at && Date.now() - Date.parse(at) > freshMs && handled.current === null) {
      handled.current = at;
      markSeen(storageKey, at);
      return;
    }
    seenFresh.current = at;
    if (!ready) return;
    handled.current = at;
    markSeen(storageKey, at);
    actRef.current(asked);
  }, [value, storageKey, ready, freshMs]);
}
