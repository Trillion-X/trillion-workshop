// tools/workflows/read-data/start-a-recipe-step.mjs
//
// How the run's AI begins one step of a recipe run: it asks for the step and is handed the step with its work. A step
// with several agents (`agents` above 1) has its lane jobs started here, by the same call, so there is no separate
// start the AI can leave out; a step with one agent starts nothing. The run is the ai-job tool:start-a-recipe-run wrote.
//
//   startARecipeStep({ input: { run, step }, task: { request_key } }, { door, most_writes })
//     -> { step: { id, title, do, submit, checks, agents, lanes? }, lane_jobs: [{ lane, job }], status }
//
// `status` is the fan-out's: 'written', 'already-there' or 'one-agent'. The step's `lane-jobs` check, judged when the
// answer is submitted (submit-a-recipe-step.mjs), is what refuses an answer for lanes that were never started.

import { agentsOf, laneIds, laneJobId } from './step-agents.mjs';
import { startAStepsAgents } from './start-a-steps-agents.mjs';

const JOB_KIND = 'ai-job';

export async function startARecipeStep({ input = {}, task = {} } = {}, { door, most_writes = 256 }) {
  const { run, step: stepId } = input;
  if (typeof run !== 'string' || !run || typeof stepId !== 'string' || !stepId) throw new Error('input.run and input.step must name the run and its step.');
  const parent = await door.read(JOB_KIND, run);
  if (!parent) throw new Error(`There is no run ${run}.`);
  const step = (parent.job ?? []).find(item => item.id === stepId);
  if (!step) throw new Error(`Run ${run} has no step "${stepId}".`);
  const { status } = agentsOf(step) === 1 ? { status: 'one-agent' } : await startAStepsAgents({ input: { run, step: stepId }, task }, { door, most_writes });
  const lane_jobs = status === 'one-agent' ? [] : laneIds(step).map(lane => ({ lane, job: laneJobId(run, stepId, lane) }));
  return { step, lane_jobs, status };
}
