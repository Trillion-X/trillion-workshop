// src/workspace/badge-counts.ts
//
// PURPOSE
//   The count on a sidebar row (what is new, what is unread) stays right between the store's answers. A typed change
//   event moves it at once and cheaply: an addition adds locally; a removal subtracts locally and then the store's own
//   count is read to settle it, because what was removed may not have been counted. The store's answer is always the
//   last word.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Additions are applied locally and never wait for a read; they cannot be wrong for long, since the next answer
//      from the store replaces the count.
//   2. Removals are reconciled, not trusted: one debounced authoritative read follows a burst of removals, and again
//      after any fetch that completed while a further event arrived (an answer that began before an event never
//      overwrites it unreconciled).
//   3. A removal only moves a count, never the rows it counts: nothing here reorders or reloads a list.
//   4. A count never goes below zero; the debounce is DATA at the caller.

export type BadgeCountsOptions = {
  /** The store's authoritative counts per surface. */
  read: () => Promise<Record<string, number>>;
  /** Shows one surface's count (0 clears it). */
  publish: (surface: string, count: number) => void;
  /** How long a burst of removals waits before the store is asked. */
  debounceMs: number;
  after?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

export function createBadgeCounts({ read, publish, debounceMs, after = (run, ms) => setTimeout(run, ms), cancel = handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }: BadgeCountsOptions) {
  const counts = new Map<string, number>();
  let timer: unknown = null;
  let fetching = false;
  let eventsSinceFetch = 0;

  const set = (surface: string, count: number) => {
    const next = Math.max(0, Math.floor(count));
    if (counts.get(surface) === next) return;
    counts.set(surface, next);
    publish(surface, next);
  };

  async function reconcile(): Promise<void> {
    if (fetching) return;
    fetching = true;
    const startedAt = eventsSinceFetch;
    try {
      const answer = await read();
      // An event that arrived while the read was on its way is newer than the answer: read again rather than overwrite it.
      if (eventsSinceFetch !== startedAt) { fetching = false; schedule(); return; }
      for (const [surface, count] of Object.entries(answer)) set(surface, count);
    } catch { /* the next event or answer settles it */ }
    fetching = false;
  }
  function schedule() {
    if (timer) cancel(timer);
    timer = after(() => { timer = null; void reconcile(); }, debounceMs);
  }

  return {
    /** Something was added that counts on `surface`: the count rises now. */
    added(surface: string, by = 1) { eventsSinceFetch += 1; set(surface, (counts.get(surface) ?? 0) + by); },
    /** Something that may have counted was removed from `surface`: the count falls now, and the store settles it soon. */
    removed(surface: string, by = 1) { eventsSinceFetch += 1; set(surface, (counts.get(surface) ?? 0) - by); schedule(); },
    /** The store's counts, as just read: they are the count now. */
    settle(answer: Record<string, number>) { for (const [surface, count] of Object.entries(answer)) set(surface, count); },
    /** The count held for a surface, or 0. */
    count: (surface: string) => counts.get(surface) ?? 0,
    /** Asks the store now (a completed fetch elsewhere, a test). */
    reconcile,
  };
}
