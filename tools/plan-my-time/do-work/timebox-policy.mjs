// tools/plan-my-time/do-work/timebox-policy.mjs
//
// Purpose
//   Whether and how a planned task becomes an event on the person's own calendar (timeboxing), chosen by the
//   `external_display` setting. Pure: it answers from a task, its placement and the clock; it writes nothing.
//
// Non-negotiable invariants
//   1. Nothing is written unless the person chose a row that writes (timebox-policy.json default `off`).
//   2. An unknown policy id writes nothing and says so; it is never read as a writing row.
//   3. The event is exactly the placement the person previewed (the proposal's start and end), never a new slot.
//   4. The at-risk test reads only the task and the proposal: a placement after its deadline, or a binding deadline
//      near the placed end.
import data from '../read-data/timebox-policy.json' with { type: 'json' };
import planner from '../read-data/schedule-planner.json' with { type: 'json' };

export const timeboxPolicies = Object.entries(data.rows).map(([id, row]) => ({ id, label: row.label, writes: row.writes === true }));

const atRisk = (task, proposal) => {
  if (proposal.late === true) return true;
  const type = planner.deadline_types[task.deadline_type ?? planner.default_deadline_type];
  const due = Date.parse(task.due ?? '');
  if (!type?.binds || !Number.isFinite(due)) return false;
  return due - Date.parse(proposal.ends_at) <= data.at_risk_hours * 3_600_000;
};

const priorityBusy = task => data.busy_priorities.includes(task.priority);

/** `{ title, start, end, transparency, visibility }` for the event to write, or null when nothing is to be written.
 *  `todoPrivacy` is the person's default todo privacy (a key of `visibility`); omitted or unknown, visibility is `default`. */
export function timeboxEvent(policyId, task, proposal, todoPrivacy) {
  const row = data.rows[policyId ?? data.default];
  if (!row?.writes) return null;
  const risky = row.at_risk_transparency && (atRisk(task, proposal) || priorityBusy(task));
  return {
    title: task.title, start: proposal.starts_at, end: proposal.ends_at, transparency: risky ? row.at_risk_transparency : row.transparency,
    visibility: Object.hasOwn(data.visibility, todoPrivacy) ? data.visibility[todoPrivacy] : 'default',
  };
}
