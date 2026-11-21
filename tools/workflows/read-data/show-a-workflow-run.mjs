// tools/workflows/read-data/show-a-workflow-run.mjs
//
// Where a run started by an event id stands, read from the person's calendar_tasks: the waiting-step tasks whose told fact
// carries that event id as its run's input.fact_id. A run's tasks are grouped by its cause key (run.run), because one fact
// can start several runs (a router-chosen fact fans out), and each run's answer holds only its tasks' ids, statuses and
// steps: never a task's whole details or the run's envelope, so the answer stays small.
//
// The read itself is one SELECT run through the person's own store (tool:run-sql-in-my-database). This module holds the
// statement and turns its rows into the answer; it reaches no database and keeps nothing.
export const SHOW_SQL = `select t.id, t.status, t.details->>'workflow' as workflow, t.details->>'step' as step,
  t.details->'told_as'->'payload'->'run'->>'run' as run_key
from calendar_tasks t
where t.details->'told_as'->'payload'->'run'->'input'->>'fact_id' = $1
order by t.created_at`;

export const SHOW_PARAMS = eventId => [eventId];

const TASKS_LIMIT = 50;

/** rows: the SHOW_SQL rows (id, status, workflow, step, run_key). Returns { event_id, runs: [{ run_key, workflow, tasks }] }. */
export function showRunsFor(eventId, rows) {
  if (typeof eventId !== 'string' || !eventId) throw new Error('give the event id the start returned.');
  const runs = new Map();
  for (const row of rows) {
    if (!row.run_key) continue;
    if (!runs.has(row.run_key)) runs.set(row.run_key, { run_key: row.run_key, workflow: row.workflow ?? null, tasks: [] });
    const run = runs.get(row.run_key);
    if (run.tasks.length < TASKS_LIMIT) run.tasks.push({ id: row.id, status: row.status, step: row.step ?? null });
  }
  return { event_id: eventId, runs: [...runs.values()] };
}
