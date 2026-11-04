// src/client-version.mjs
//
// Purpose: one minimum-version record the Worker owns (src/client-version.json), and the one test every open page runs
// against it, so a change to what the store accepts can ship without an old tab writing the old shape: the Worker
// answers which page builds may keep working, each page compares the build it is with the answer, and a page that may
// not shows a reload screen (src/workspace/client-version.ts).
//
// Non-Negotiable Invariants:
//   1. The Worker answers only what it was deployed with (`minimum_generation`, `lock_out_before`); nothing here asks the
//      person's store, so the check costs no store request.
//   2. Locked out means: this page's baked `generation` is below the minimum, or the page was opened before
//      `lock_out_before`. Anything else, including an answer that is missing, malformed or failed, is not locked out
//      (a check that fails never locks a tab out).

import settings from './client-version.json' with { type: 'json' };

/** What GET /work/api/client-version answers (invariant 1). */
export const clientVersionAnswer = () => ({ minimum_generation: settings.minimum_generation, lock_out_before: settings.lock_out_before });

/** Whether a page of build `generation`, opened at `openedAt` (ms since the epoch), may not keep working (invariant 2). */
export function lockedOut(answer, { generation = settings.generation, openedAt }) {
  if (!answer || typeof answer !== 'object') return false;
  if (Number.isSafeInteger(answer.minimum_generation) && generation < answer.minimum_generation) return true;
  const before = typeof answer.lock_out_before === 'string' ? Date.parse(answer.lock_out_before) : NaN;
  return Number.isFinite(before) && Number.isFinite(openedAt) && openedAt < before;
}
