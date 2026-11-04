// tools/compare-two-ai-builds-on-trap-tasks/do-work/compare-two-builds.mjs
//
// tool:compare-two-ai-builds-on-trap-tasks. The row's request ({ left, right, battery? }) handed to the moved
// compareArms (src/behavior-compare.mjs); battery, when given, replaces src/behavior-evals.json for this run and is
// checked first (batteryProblems), so a battery naming an unknown scorer is refused in its own words.
import { batteryProblems, compareArms } from '../src/behavior-compare.mjs';

export function compareTwoBuilds({ left, right, battery } = {}) {
  for (const [name, trace] of [['left', left], ['right', right]]) {
    if (!trace || typeof trace !== 'object' || !Array.isArray(trace.runs)) throw new Error(`Give ${name}: one arm's trace { arm, runs: [{ task_id, state, calls: [{ tool }] }] }, written from the calls its runs recorded.`);
  }
  if (battery !== undefined) {
    if (!battery || !Array.isArray(battery.tasks)) throw new Error('battery is { tasks: [{ id, class, scorers: [{ kind, ... }] }] }; leave it out to use the trap battery this tool carries.');
    const problems = batteryProblems(battery);
    if (problems.length) throw new Error(problems.join(' '));
    return compareArms(left, right, battery);
  }
  return compareArms(left, right);
}
