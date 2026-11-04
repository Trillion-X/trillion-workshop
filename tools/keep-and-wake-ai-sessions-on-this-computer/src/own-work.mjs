// src/own-work.mjs
//
// Purpose
//   The one answer to "is this job the person's own words?", read by the cloud AI (src/own-ais-routing.mjs) and by the
//   helper on their computer (harness/take-open-work.mjs), so both put what the person just said ahead of a backlog.
//
// Non-negotiable invariants
//   1. A job is the person's own when it carries their arrival with from_person true, whatever priority the rule that
//      handed it gave it. On 2026-10-08 a question the person sent at 03:58Z was handed by a workflow rule at priority 3,
//      so both takers counted it as ordinary background work: capped by the day's limit and queued behind 625 older
//      jobs, and nothing took it for hours.
//   2. A job at or above the priority line src/inbound-words.json sets for the person's words is theirs too (a share from
//      their phone carries the priority and no arrival).
//   3. Nothing here names an app, a rule or a workflow: the arrival says who it is from.
//
import inboundWords from './inbound-words.json' with { type: 'json' };

/** Whether a job is the person's own words (see invariants 1 and 2). */
export const isOwnWork = item => (item?.priority ?? 0) >= inboundWords.priority.from_person || item?.input?.arrived?.from_person === true;

/** Order for taking: the person's own work first, the newest of it first (what they just said is never left behind older
 * words), then the rest by priority and age, oldest first. */
export const rankOf = item => Math.max(item?.priority ?? 0, isOwnWork(item) ? inboundWords.priority.from_person : 0);

export function takingOrder(a, b) {
  const byRank = rankOf(b) - rankOf(a);
  if (byRank) return byRank;
  const older = String(a.handed_at).localeCompare(String(b.handed_at));
  return (isOwnWork(a) ? -older : older) || a.handoff_id.localeCompare(b.handoff_id);
}
