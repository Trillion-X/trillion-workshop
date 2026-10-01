// tools/move-records-through-declared-states/do-work/check-a-pipeline.mjs
//
// Checks a set of stages and the moves between them before anyone relies on it: two stages with one key, a move out
// of a finished stage, a move naming a stage that does not exist, and stages no path from the start ever reaches. Run
// by the Workshop tool `tool:check-a-pipeline` in the tool container:
//
//   node do-work/check-a-pipeline.mjs < <the input as JSON>
//
// and prints { sound, problems, reachable, unreachable } as JSON on its last line. A problem is reported, not thrown,
// because finding them is this tool's job.
import { text } from 'node:stream/consumers';
import { reachableFrom, statesByKey, transitionsFrom, unreachableStates } from './move-records-through-declared-states.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
const problems = [];
let reachable = [];
let unreachable = [];
try {
  const states = statesByKey(input.stages);
  const transitions = transitionsFrom(input.transitions, states);
  if (!states.has(input.start)) problems.push(`the start stage "${input.start}" is not one of the stages`);
  else {
    reachable = [...reachableFrom(transitions, input.start)];
    unreachable = unreachableStates(states, transitions, input.start);
    for (const key of unreachable) problems.push(`no move from the start ever reaches "${key}"`);
  }
} catch (error) {
  problems.push(error.message);
}
console.log(JSON.stringify({ sound: problems.length === 0, problems, reachable, unreachable }));
