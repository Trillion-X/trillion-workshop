// parts/ui/show/selection/tray-store.ts
//
// NO PRIOR: searched bitfield-packages/packages for "tray", "selection tray", "basket", "picked things", "Send to
// Trillion", "feedback" and "bug report". packages/ui/show/selection/useSelection.ts (ported here unchanged) holds one
// surface's selection inside one React tree; packages/bug-reports holds a three-field bug form (what you did, what you
// expected, what happened) and is not ported, because problems, feedback and ideas are one thing here. Nothing kept
// picked things across screens, so this is new, built over the same NodeRef-style identity `useSelection` uses.
//
// PURPOSE
//   The tray: the things a person picked anywhere on the page (a screen, a row, a message, a file, a piece of the
//   page), kept across screens and page loads until they act on them or clear it. One store per page; every picker
//   (a click while picking, a dragged box, the right-click menu) adds to it, and every screen that shows the tray reads
//   it. It also says whether the page is picking right now (clicks pick instead of opening).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A thing is identified by its `key`; adding the same key twice keeps one, at its first place.
//   2. The store knows nothing about what a thing is: `kind`, `label`, `icon` and the rest are whatever the picker
//      read from the page, kept as given.
//   3. When a caller sets a positive `limit`, the tray keeps that many newest things; null means no product-sized cap.
//   4. It is kept in the browser (the storage the caller names) and nowhere else; nothing is sent until the person
//      chooses an action.
//   5. Each thing keeps when it first joined the tray (`picked_at`), so a screen can say "2 min ago".
//   6. The tray is kept for the signed-in account (accountKey): another account on this browser never reads or sends
//      it. With no account on the page it lasts for this page only, and an older fixed-key tray is parked, never read.

import { useSyncExternalStore } from 'react';
import { pageStorage, accountKey } from '../page-storage/page-storage';

/** One picked thing, as the page showed it. */
export type TrayThing = {
  /** Identity: the same thing picked twice has the same key. */
  key: string;
  /** What it is, in the page's own words (a row, a screen, a message). */
  kind: string;
  /** Its name as it reads on the page. */
  label: string;
  icon?: string;
  /** The screen it was picked on, and that screen's name. */
  screen?: string;
  screen_label?: string;
  /** The page address it was picked at. */
  address?: string;
  /** The record id it carries, when the page gave it one. */
  id?: string;
  /** The selected record's canonical sharing reference, supplied by its screen. */
  share_record?: string;
  /** A web address the selected thing explicitly carries, when it is shareable as a link. */
  share_url?: string;
  /** Words the selected thing explicitly carries, when it is shareable as text. */
  share_text?: string;
  /** The shared place it was picked in (a space), when it was picked inside one; none means the person's own work. */
  context?: { kind: string; id: string };
  /** When it was picked, in milliseconds; the store stamps it when the thing first joins the tray. */
  picked_at?: number;
};

/** Give every picker the same identity for one shareable record, even when two screens name its row differently. */
export function trayKeyOf(thing: Pick<TrayThing, 'kind' | 'label' | 'id' | 'screen' | 'share_record' | 'context'>): string {
  const place = thing.context ? `${thing.context.kind}:${thing.context.id}:` : '';
  return `${thing.kind}:${place}${thing.share_record ?? thing.id ?? `${thing.screen ?? ''}:${thing.label}`}`;
}

export type TrayState = { things: readonly TrayThing[]; picking: boolean };

export type TrayStore = {
  read(): TrayState;
  subscribe(listener: () => void): () => void;
  add(things: readonly TrayThing[]): void;
  remove(key: string): void;
  clear(): void;
  setPicking(on: boolean): void;
};

/** A tray kept under `storageKey` in `storage` (this device's, by default; none keeps it for this page only); null
 *  leaves the number of picked references uncapped. */
export function makeTrayStore({ storageKey, limit = 50, storage = pageStorage() }: { storageKey: string; limit?: number | null; storage?: Storage | null }): TrayStore {
  const listeners = new Set<() => void>();
  // The tray kept under this signed-in account; null (no account on the page) keeps it for this page only.
  const keptKey = accountKey(storageKey);
  const load = (): TrayThing[] => {
    try {
      const kept = JSON.parse((keptKey && storage?.getItem(keptKey)) || '[]');
      if (!Array.isArray(kept)) return [];
      const seen = new Set<string>();
      return kept.filter(thing => thing && typeof thing.key === 'string' && typeof thing.label === 'string')
        .map((thing: TrayThing) => typeof thing.kind === 'string' && typeof thing.share_record === 'string' && thing.share_record
          ? { ...thing, key: trayKeyOf(thing) } : thing)
        .filter((thing: TrayThing) => !seen.has(thing.key) && Boolean(seen.add(thing.key)));
    } catch {
      return [];
    }
  };
  let state: TrayState = { things: load(), picking: false };
  const set = (next: TrayState) => {
    state = next;
    try { if (keptKey) storage?.setItem(keptKey, JSON.stringify(next.things)); } catch { /* a full or blocked storage keeps the tray for this page only */ }
    for (const listener of listeners) listener();
  };
  return {
    read: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    add(things) {
      const seen = new Set(state.things.map(thing => thing.key));
      const now = Date.now();
      const added = things.filter(thing => !seen.has(thing.key) && Boolean(seen.add(thing.key))).map(thing => ({ ...thing, picked_at: thing.picked_at ?? now }));
      if (added.length) {
        const collected = [...state.things, ...added];
        set({ ...state, things: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? collected.slice(-limit) : collected });
      }
    },
    remove(key) { set({ ...state, things: state.things.filter(thing => thing.key !== key) }); },
    clear() { set({ ...state, things: [] }); },
    setPicking(on) { if (state.picking !== on) set({ ...state, picking: on }); },
  };
}

/** The tray's current state in a React tree, redrawn on every change. */
export function useTray(store: TrayStore): TrayState {
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}
