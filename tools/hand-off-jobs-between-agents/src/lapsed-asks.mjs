// src/lapsed-asks.mjs
//
// PURPOSE
//   Work its asker stopped waiting for (an open job whose take_by has passed, src/agents.mjs lapsed) is let go of only
//   when a take or a full queue happens to meet it, so a job nobody comes to take stays open for good. This is the
//   scheduler source that meets them: a few per wake, from the index on take_by, resuming where the last wake stopped.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The rule is the take's, no other: a job is let go of only when it is open, not closing and its take_by has
//      passed (agents.sweepLapsed). A job whose take_by has not passed, or that has none, is never read or changed.
//   2. A wake lets go of at most per_wake jobs and looks at no more than addressees_per_wake addressees, however much
//      work is waiting, and none once the scheduler's stage budget is spent: what is left waits for the next wake.
//   3. This source wakes an idle store for nothing but a take_by: its time is the earliest take_by of open work
//      (agents.nextLapseAt: one read of the first entry of the index on take_by, kept by the scheduler and asked again only
//      after a handoff was written or this source ran), or again_after_seconds after a wake that stopped with work left, and none when no open work has
//      a take_by. A store with no such work is never woken by it (test/idle-store-wakes).
//   4. Where the sweep stopped is held in memory only. A restarted store starts again from the first addressee, which
//      costs one look at each and lets go of nothing that was let go of already, so nothing is written to keep it.
//   5. Timing and sizes are DATA (src/lapsed-asks.json).
//
import settings from './lapsed-asks.json' with { type: 'json' };

/** `sweep(...)` is agents.sweepLapsed and `earliest()` agents.nextLapseAt (a store may open its agents again); `now()` is ms. Returns { nextAt(), run(stage) }. */
export function lapsedAsks({ sweep, earliest, now = () => Date.now() }) {
  let from;
  let again = null;
  return {
    nextAt: () => again ?? earliest(),
    run(stage) {
      if ((stage?.left?.() ?? Infinity) <= 0) { again = now() + settings.again_after_seconds * 1000; return { let_go: 0, more: true }; }
      const swept = sweep({ limit: settings.per_wake, addressees: settings.addressees_per_wake, from });
      from = swept.from;
      again = swept.more ? now() + settings.again_after_seconds * 1000 : null;
      return { let_go: swept.let_go, more: swept.more };
    },
  };
}
