// tools/workflows/read-data/read-a-recipe-run.mjs
//
// Where one recipe run stands, read from the rows this tool's own steps keep, writing nothing: the run's job row
// (`ai-job:<recipe id>:<request key>`, written by start-a-recipe-run.mjs) and each step's kept answer
// (`<run>#answer:<step>`, written by submit-a-recipe-step.mjs only after every check of the step passed). Any screen or
// AI that shows how far a run has got reads it here, so the run and answer ids stay in the tool that makes them.
//
//   readARecipeRun({ recipe, request_key }, { sql })
//     -> { run, exists, status, label, input, steps: [{ id, kept, answer?, kept_by?, kept_at?, answer_id? }], finished }
//
// A run that was never started reads `exists: false` with no steps: nothing about it is guessed. An answer row counts as
// kept only as submit-a-recipe-step keeps it (status done, finished by that tool, naming this run and this step); any
// other row under that id is not a kept answer. `finished` is true only when every step of the run has its kept answer.

import { answerId, readJob, runId } from './step-agents.mjs';

const KEEPER = 'workflow:submit-a-recipe-step';
export { runId };

/** The kept answer row of `step` of `run`, or null when the row is not one submit-a-recipe-step kept. */
const keptAnswer = (row, run, step) =>
  row && row.status === 'done' && row.finished_by === KEEPER && row.parent === run && row.step === step ? row : null;

export async function readARecipeRun({ recipe, request_key: requestKey } = {}, { sql } = {}) {
  if (typeof recipe !== 'string' || !recipe) throw new Error('recipe names the recipe whose run this is.');
  if (typeof requestKey !== 'string' || !requestKey) throw new Error('request_key names the run of that recipe.');
  const run = runId(recipe, requestKey);
  const job = await readJob(sql, run);
  if (!job) return { run, exists: false, status: null, label: null, input: null, steps: [], finished: false };
  const steps = [];
  for (const step of Array.isArray(job.job) ? job.job : []) {
    const kept = keptAnswer(await readJob(sql, answerId(run, step.id)), run, step.id);
    steps.push(kept ? { id: step.id, kept: true, answer: kept.answer, kept_by: kept.finished_by, kept_at: kept.kept_at ?? null, answer_id: answerId(run, step.id) }
      : { id: step.id, kept: false });
  }
  return {
    run, exists: true, status: job.status ?? null, label: job.label ?? null, input: job.input ?? null, steps,
    finished: steps.length > 0 && steps.every(step => step.kept),
  };
}
