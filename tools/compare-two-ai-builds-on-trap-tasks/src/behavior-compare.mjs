// src/behavior-compare.mjs
//
// PURPOSE
//   Compares two arms (two builds of an AI's behaviour that differ in one thing) on a battery of trap tasks
//   (src/behavior-evals.json), scoring every task from the calls its run recorded. Pure: the traces are given.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A score comes only from recorded calls and the recorded end state; nothing a run says about itself counts.
//   2. Both arms are scored over the same denominator, the whole battery: a task an arm has no run for, or whose run
//      did not end, scores 0 for that arm and is still counted.
//   3. The traces, the traps and the scorer kinds are data or an argument; nothing here names a tool or a task.
import battery from './behavior-evals.json' with { type: 'json' };

const calledAt = (calls, tool) => calls.findIndex(call => call.tool === tool);
const SCORERS = {
  max_calls: (scorer, run) => run.calls.length <= scorer.n,
  forbids_tool: (scorer, run) => calledAt(run.calls, scorer.tool) < 0,
  requires_tool: (scorer, run) => calledAt(run.calls, scorer.tool) >= 0,
  calls_before: (scorer, run) => {
    const first = calledAt(run.calls, scorer.first), then = calledAt(run.calls, scorer.then);
    return then < 0 || (first >= 0 && first < then);
  },
  ends_in: (scorer, run) => run.state === scorer.state,
};

/** The scorer kinds this build knows, so a battery row naming another is refused when it is checked. */
export const scorerKinds = () => Object.keys(SCORERS);

/** A battery's problems in words (an unknown scorer kind, a task twice, a task with no scorer). */
export function batteryProblems(rows = battery) {
  const problems = [], seen = new Set();
  for (const task of rows.tasks) {
    if (seen.has(task.id)) problems.push(`${task.id} is in the battery twice.`);
    seen.add(task.id);
    if (!task.scorers?.length) problems.push(`${task.id} has no scorer.`);
    for (const scorer of task.scorers ?? []) if (!SCORERS[scorer.kind]) problems.push(`${task.id} names the scorer ${scorer.kind}, which is not one of ${scorerKinds().join(', ')}.`);
  }
  return problems;
}

/** One arm's trace { arm, runs: [{ task_id, state, calls: [{ tool }] }] } scored over the whole battery. */
export function scoreArm(trace, rows = battery) {
  const problems = batteryProblems(rows);
  if (problems.length) throw new Error(problems[0]);
  const byTask = new Map((trace.runs ?? []).map(run => [run.task_id, { ...run, calls: Array.isArray(run.calls) ? run.calls : [] }]));
  const tasks = rows.tasks.map(task => {
    const run = byTask.get(task.id);
    const passed = run ? task.scorers.every(scorer => SCORERS[scorer.kind](scorer, run)) : false;
    return { task_id: task.id, class: task.class, ran: Boolean(run), score: passed ? 1 : 0 };
  });
  const classes = {};
  for (const task of tasks) {
    const row = (classes[task.class] ??= { score: 0, of: 0 });
    row.score += task.score;
    row.of += 1;
  }
  return { arm: trace.arm ?? null, score: tasks.reduce((sum, task) => sum + task.score, 0), of: tasks.length, ran: tasks.filter(task => task.ran).length, classes, tasks };
}

/** Both arms over the same battery, with the tasks on which they differ. */
export function compareArms(left, right, rows = battery) {
  const a = scoreArm(left, rows), b = scoreArm(right, rows);
  return { arms: [a, b], same_denominator: a.of === b.of, differ: a.tasks.filter((task, at) => task.score !== b.tasks[at].score).map(task => task.task_id) };
}
