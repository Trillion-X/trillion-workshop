// src/workspace/unsaved-work.ts
//
// PURPOSE
//   What a host app asks every loaded page before it quits or closes a window: how much work this page holds that has
//   not reached the person's store yet, in plain words. The Mac app asks each loaded web view (macos/App/LiveSurfaces.swift)
//   and shows one Quit / Cancel question when any answers some.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One count, from the page's one registry of unsaved work (leave-blockers.ts): the outbox's writes the store has not
//      accepted (quiet-writes.ts) are one of its counters, read when asked, never cached.
//   2. The answer is plain JSON ({ count, words }), so a host reads it without knowing anything of the page.
//   3. Published once per page; publishing again changes nothing.

import { leaveBlockers, leaveRefusal, registerLeaveCounter } from './leave-blockers';
import { quietWritesWaiting } from './quiet-writes';

export type UnsavedWork = { count: number; words: string | null };

let published = false;

/** How much unsaved work this page holds now (invariants 1 and 2). */
export function unsavedWork(): UnsavedWork {
  return { count: leaveBlockers().reduce((sum, row) => sum + row.count, 0), words: leaveRefusal() };
}

/** Publishes `window.trillionUnsaved()` for a host app to ask before it quits (invariant 3). */
export function publishUnsavedWork(): void {
  if (published) return;
  published = true;
  registerLeaveCounter('edit', quietWritesWaiting);
  (window as unknown as { trillionUnsaved?: () => UnsavedWork }).trillionUnsaved = unsavedWork;
}
