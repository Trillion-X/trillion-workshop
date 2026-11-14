// tools/workflows/read-data/submit-a-recipe-step.mjs
//
// Takes the answer of one step of a recipe run, judges the step's checks and keeps the answer only when they all pass.
// The caller gives the run, the step and the answer; it does not give the catalogs the checks look things up in. The
// `ran-job` catalog is built here from the records themselves: each lane of the step has its own ai-job
// (<run>:<step>:<lane>, written by start-a-recipe-step.mjs) and the catalog answers the taker that finished it, only
// for a job whose status is done. An input that carries a catalog is refused, so no caller can say a job ran.
//
//   submitARecipeStep({ input: { run, step, answer }, task }, { door })
//     -> { status: 'kept' | 'already-there', answer_id, checks: [{ kind, says, passed }], unchecked: [{ kind, says, reason }] }
//
// A check that fails refuses the answer with the failing values and keeps nothing. A check this module cannot judge
// (for example `exists` with no catalog to look in) is listed under `unchecked`, never reported as passed. Earlier
// steps' answers are what `steps.<id>` reads, so every earlier step must have its answer kept first.
//
// The kept answer is the ai-job row `<run>#answer:<step>`, status done. The first answer kept for a step stays: a
// submit that comes again finds it and changes nothing.

import { laneIds, laneJobId, runStep, runsLaneJobs } from './step-agents.mjs';
import { checkResults, valuesAt } from './recipe-check-results.mjs';
import { readFileSync } from 'node:fs';
import { resolveItem } from './citation-resolvers.mjs';

const JOB_KIND = 'ai-job';
const CHECK_VOCABULARY = JSON.parse(readFileSync(new URL('../recipe-check-kinds.json', import.meta.url), 'utf8'));
const ALLOWED_INPUT = new Set(['run', 'step', 'answer']);
export const answerId = (run, step) => `${run}#answer:${step}`;

export async function submitARecipeStep({ input = {}, task = {} } = {}, { door, resolvers }) {
  for (const key of Object.keys(input)) if (!ALLOWED_INPUT.has(key)) throw new Error(`input.${key} is not taken: the checks look jobs up in the records themselves, never in what the caller gives.`);
  const { run, step: stepId, answer } = input;
  if (typeof run !== 'string' || !run || typeof stepId !== 'string' || !stepId) throw new Error('input.run and input.step must name the run and its step.');
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('input.answer must be the step\'s answer, an object.');
  if (typeof task.request_key !== 'string' || !task.request_key) throw new Error('task.request_key is missing.');
  const parent = await door.read(JOB_KIND, run);
  if (!parent) throw new Error(`There is no run ${run}.`);
  const steps = parent.job ?? [];
  const at = steps.findIndex(item => item.id === stepId);
  if (at < 0) throw new Error(`Run ${run} has no step "${stepId}".`);
  // The step as this run runs it: the run's agents_per_step over the row's agents (runStep), as the starter read it.
  const step = runStep(steps[at], parent.input);
  const id = answerId(run, stepId);
  if (await door.read(JOB_KIND, id)) return { status: 'already-there', answer_id: id, checks: [], unchecked: [] };

  const earlier = {};
  for (const before of steps.slice(0, at)) {
    const kept = await door.read(JOB_KIND, answerId(run, before.id));
    if (!kept) throw new Error(`Step "${before.id}" has no answer kept yet, and step "${stepId}" comes after it.`);
    earlier[before.id] = kept.answer;
  }

  // The lane jobs as the records hold them: the taker that finished each, nothing for one that did not.
  const takers = new Map();
  if (runsLaneJobs(step) || (step.checks ?? []).some(check => check.kind === 'lane-jobs')) {
    for (const lane of laneIds(step, earlier)) {
      const job = laneJobId(run, stepId, lane);
      const row = await door.read(JOB_KIND, job);
      if (row?.status === 'done' && typeof row.finished_by === 'string' && row.finished_by) takers.set(job, row.finished_by);
    }
  }
  const catalogs = { 'ran-job': job => takers.get(job) ?? null };
  const context = { this: answer, input: parent.input ?? {}, steps: earlier, run };
  // What the answer cites is looked up first (a lookup is async), then the checks are judged on what was found.
  const looked = new Map();
  for (const check of (step.checks ?? []).filter(item => item.kind === 'cites-resolve')) {
    for (const item of valuesAt(check.path, context)) looked.set(`${at}:${(step.checks).indexOf(check)}:${JSON.stringify(item)}`, await resolveItem(check, item, { resolvers, door }));
  }
  const resolved = (check, item) => looked.get(`${at}:${step.checks.indexOf(check)}:${JSON.stringify(item)}`);
  const results = checkResults(step, context, { catalogs, resolved });
  const failed = results.filter(result => result.passed === false);
  // A kind whose row says `refuse_unchecked` is a gate: when it cannot be judged here (a repository is not on this
  // computer) the answer is refused, never kept as unchecked.
  const gates = new Set(CHECK_VOCABULARY.kinds.filter(row => row.refuse_unchecked).map(row => row.kind));
  const blind = results.filter(result => result.evaluated === false && gates.has(result.kind));
  if (blind.length) throw new Error(`The answer to step "${stepId}" cannot be judged here: ${blind.map(result => `${result.says} (${result.reason})`).join('; ')}`);
  if (failed.length) throw new Error(`The answer to step "${stepId}" fails: ${failed.map(result => `${result.says} (failing: ${JSON.stringify(result.failing)})`).join('; ')}`);
  const value = { kind: JOB_KIND, status: 'done', row: parent.row, label: `${parent.label}: answer of ${step.title ?? step.id}`, parent: run, step: stepId, answer, finished_by: 'workflow:submit-a-recipe-step' };
  await door.write([{ id, type: JOB_KIND, value }], { key: `${run}:${stepId}:answer` });
  return {
    status: 'kept', answer_id: id,
    checks: results.filter(result => result.passed).map(({ kind, says, passed }) => ({ kind, says, passed })),
    unchecked: results.filter(result => result.evaluated === false).map(({ kind, says, reason }) => ({ kind, says, reason })),
  };
}
