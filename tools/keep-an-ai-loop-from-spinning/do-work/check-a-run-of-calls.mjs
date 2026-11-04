// tools/keep-an-ai-loop-from-spinning/do-work/check-a-run-of-calls.mjs
//
// The row's seam over read-data/loop-guards.mjs: a model loop's tool calls, in the order they were made, go through one
// loop guard and each answer is said. The first give_back ends the run: the calls after it are not looked at.
//
//   checkRunOfCalls({ calls: [{ name, args, failed?, malformed? }], rules? }) -> { steps: [{ at, nudge?, give_back? }], give_back? }
import { makeLoopGuard } from '../read-data/loop-guards.mjs';
import shipped from '../read-data/loop-guards.json' with { type: 'json' };

export function checkRunOfCalls({ calls = [], rules } = {}) {
  const guard = makeLoopGuard(rules ?? shipped);
  const steps = [];
  for (const [at, call] of calls.entries()) {
    const answer = guard.after(call ?? {});
    if (!answer) continue;
    steps.push({ at, ...answer });
    if (answer.give_back) return { steps, give_back: answer.give_back, at };
  }
  return { steps };
}
