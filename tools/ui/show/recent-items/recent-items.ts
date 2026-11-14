// packages/ui/show/recent-items/recent-items.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A most-recently-used (MRU) list: unique items (deduped by key), most-recent
// FIRST, capped to a max length. Re-recording an item moves it to the front.
//
// This is a DIFFERENT ALGEBRA from a positional navigation cursor
// (`nav-arrows/node-history-model` — the NavigationTrail with a cursor +
// back/forward + drop-forward-on-mid-stack-visit). An MRU recents list has NO
// cursor, NO back/forward, NO drop-forward. Conflating the two is an L069 false
// primitive (clay-vs-clay only LOOKS unified): a back/forward pane history and a
// "recent items" jump list answer different questions and must not share a model.
//
//   - NavigationTrail  → screen-arrangement per-pane back/forward (cursor drives nav)
//   - RecentItems      → web-frame "Recent pages" jump list (native nav drives nav;
//                        this is only the recency log for the dropdown)
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Pure data — no React, no DOM, no I/O. A reducer over an immutable list.
// 2. Generic — `key` is an opaque identity string the OWNER chooses (a URL, an
//    id). This module is blind to what an item IS.
// 3. No magic cap — the cap is caller DATA, never a constant here.
// =============================================================================

export interface RecentItem {
  /** Opaque identity for dedup (e.g. a URL). Same key = same item. */
  readonly key: string;
  /** Human label for the row. */
  readonly label: string;
  /** Visit timestamp (ms since epoch). */
  readonly ts: number;
}

/**
 * Record a visit to `item`: insert/move it to the FRONT (most recent), dedup by
 * key, and cap the list to `cap` entries (dropping the oldest). Returns a new
 * list — pure. Re-recording the current front item still returns a new list with
 * a refreshed timestamp at the front (idempotent on order, not on ts).
 */
export function recordRecent(
  list: readonly RecentItem[],
  item: RecentItem,
  cap: number,
): RecentItem[] {
  const without = list.filter((entry) => entry.key !== item.key);
  const next = [item, ...without];
  return next.length > cap ? next.slice(0, cap) : next;
}

/** Remove an item by key (e.g. user clears one). Pure. */
export function forgetRecent(list: readonly RecentItem[], key: string): RecentItem[] {
  return list.filter((entry) => entry.key !== key);
}
