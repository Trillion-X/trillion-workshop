// tools/hand-work-to-ais/read-data/job-run-actions.mjs
//
// PURPOSE
//   The three buttons of the job-run screen (take, finish, withdraw-waiting) as pure functions: each one names the task
//   move it is in tools/plan-tasks-and-todo-lists/task-moves.json (take, finish, withdraw) and the input that move takes.
//   The screen does not call these yet. Its buttons wait for the person's word, and the tool rows that would carry them wait
//   for a real run on the Mac (see the README of this folder). Nothing here reads or writes a store.
//
// NOT PORTED (stated, not hidden)
//   follow-up (the old /work/api/job-run/follow-up road) has no task move in task-moves.json, so it returns null.
//   withdraw no longer takes the old job revision: a task move is checked by its own conditional write, not a revision.
//
// INVARIANTS
//   1. An action the screen does not name, or a job the run does not hold, returns null.
//   2. take needs no input beyond the task id; finish needs a non-empty result of at most 60000 characters and a check.
//   3. withdraw is allowed only for a job still open (the screen's old rule), and needs the reason ("because").
const MOVE_OF = Object.freeze({ take: 'take', finish: 'finish', 'withdraw-waiting': 'withdraw' });
const MOST_RESULT_CHARS = 60000;

export function jobActionMoveOf(run, id, action, given = {}) {
  if (!Object.prototype.hasOwnProperty.call(MOVE_OF, action)) return null;
  const job = run?.jobs?.find(item => item.handoff_id === id);
  if (!job) return null;
  const move = MOVE_OF[action];
  if (move === 'take') return { move, input: { task_id: id } };
  if (move === 'finish') {
    const { result, check, summary = null } = given;
    if (typeof result !== 'string' || !result.trim() || result.length > MOST_RESULT_CHARS) return null;
    if (check === undefined || check === null || check === '') return null;
    return { move, input: { task_id: id, result, check, summary } };
  }
  if (job.state !== 'open') return null;
  const because = given.because;
  if (typeof because !== 'string' || !because.trim()) return null;
  return { move, input: { task_id: id, because } };
}
