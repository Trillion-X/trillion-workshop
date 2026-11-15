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
// The answer is first judged against the step's `submit` schema (answer-schema.mjs); one that does not fit is refused
// naming each bad field path. A check that fails refuses the answer with the failing values and keeps nothing. A check this module cannot judge
// (for example `exists` with no catalog to look in) is listed under `unchecked`, never reported as passed. Earlier
// steps' answers are what `steps.<id>` reads, so every earlier step must have its answer kept first.
//
// The kept answer is the ai-job row `<run>#answer:<step>`, status done, with the time it was kept (`kept_at`). The first
// answer kept for a step stays: a
// submit that comes again finds it and changes nothing.

import { answerId, laneIds, laneJobId, runId, runStep, runsLaneJobs, slottedRunKey } from './step-agents.mjs';
import { readARecipeRun } from './read-a-recipe-run.mjs';
import { checkResults, valuesAt } from './recipe-check-results.mjs';
import { readFileSync } from 'node:fs';
import { resolveItem } from './citation-resolvers.mjs';
import { schemaProblems } from './answer-schema.mjs';
import { publicRecipes } from './public-recipes.mjs';

const JOB_KIND = 'ai-job';
const CHECK_VOCABULARY = JSON.parse(readFileSync(new URL('../recipe-check-kinds.json', import.meta.url), 'utf8'));
const ROW_TYPES = JSON.parse(readFileSync(new URL('../arrivals/recipe-row-types.json', import.meta.url), 'utf8'));
const ALLOWED_INPUT = new Set(['run', 'step', 'answer', 'rows_of']);
export { answerId };

// A row's slot field as workflow ids: a list, JSON text holding a list, or one id. Anything else is no workflow.
export function slotWorkflows(value) {
  let held = value;
  if (typeof held === 'string' && held.trim().startsWith('[')) { try { held = JSON.parse(held); } catch { return null; } }
  const ids = (Array.isArray(held) ? held : held === undefined || held === null || held === '' ? [] : [held]);
  if (!ids.every(id => typeof id === 'string' && id.trim())) return null;
  return [...new Set(ids.map(id => (id.startsWith('workflow:') ? id : `workflow:${id}`)))];
}

// For each row a slotted-runs check of the step names (rows of the one list type `rows_of` names): the row read through the door, its slot field's workflows, and
// for each the sub-run `runId(workflow, slottedRunKey(run, step, row))` read the way read-a-recipe-run reads any run.
async function slottedRows(step, context, { run, stepId, rowsOf, door }) {
  const slots = new Map();
  for (const check of (step.checks ?? []).filter(item => item.kind === 'slotted-runs')) {
    for (const item of valuesAt(check.path, context)) {
      const row = item?.[check.row], type = item?.[check.type];
      const key = `${type}\n${row}`;
      if (slots.has(key)) continue;
      if (typeof row !== 'string' || !row || typeof type !== 'string' || !type) { slots.set(key, { missing: `names no row id and type in ${check.row} and ${check.type}` }); continue; }
      // The run may read only the one list its caller named (tool:submit-a-step-that-slots-rows is given read on rows_of).
      if (type !== rowsOf) { slots.set(key, { missing: `is a ${type} row; hand the step in with tool:submit-a-step-that-slots-rows and rows_of ${type}` }); continue; }
      const value = await door.read(type, row);
      if (!value) { slots.set(key, { missing: `there is no ${type} row ${row}` }); continue; }
      const workflows = slotWorkflows(value[check.slot]);
      if (!workflows) { slots.set(key, { missing: `its ${check.slot} is not a workflow id or a list of them` }); continue; }
      const runs = [];
      for (const workflow of workflows) {
        const read = await readARecipeRun({ recipe: workflow, request_key: slottedRunKey(run, stepId, row) }, { door });
        runs.push({ workflow, run: runId(workflow, slottedRunKey(run, stepId, row)), finished: read.finished });
      }
      slots.set(key, { workflows: runs });
    }
  }
  return slots;
}

// The workflow ids the step's `exists` checks on the workflow catalog name that the account can run (startable by
// tool:start-a-recipe-run): a row of the person's list of workflows, else a recipe in the Workshop's recipes folder.
async function knownWorkflows(step, context, door) {
  const known = new Set();
  const asked = new Set((step.checks ?? []).filter(check => check.kind === 'exists' && check.catalog === 'workflow')
    .flatMap(check => valuesAt(check.path, context)).filter(id => typeof id === 'string' && id.startsWith('workflow:')));
  if (!asked.size) return known;
  const shipped = new Set(publicRecipes().map(payload => payload.id));
  for (const id of asked) {
    if (shipped.has(id)) { known.add(id); continue; }
    for (const type of ROW_TYPES.recipe.types) {
      if (await door.read(type, `${ROW_TYPES.recipe.id_prefix}${id.slice('workflow:'.length)}`)) { known.add(id); break; }
    }
  }
  return known;
}

export async function submitARecipeStep({ input = {}, task = {} } = {}, { door, resolvers }) {
  for (const key of Object.keys(input)) if (!ALLOWED_INPUT.has(key)) throw new Error(`input.${key} is not taken: the checks look jobs up in the records themselves, never in what the caller gives.`);
  const { run, step: stepId, answer, rows_of: rowsOf } = input;
  if (rowsOf !== undefined && !(typeof rowsOf === 'string' && rowsOf.startsWith('record:'))) throw new Error('input.rows_of must name the list row type the step\'s chosen rows are kept as (record:<type>).');
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

  // The answer must fit the step's own `submit` schema before any check is judged or anything is kept.
  const problems = step.submit ? schemaProblems(step.submit, answer) : [];
  if (problems.length) throw new Error(`The answer to step "${stepId}" does not fit the step's submit schema: ${problems.map(({ path, why }) => `${path} ${why}`).join('; ')}`);

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
  const context = { this: answer, input: parent.input ?? {}, steps: earlier, run };
  // The rows the step chose, read from the account with their own workflows, and each workflow's sub-run of this step as
  // the run's records hold it (slottedRows): the slotted-run catalog.
  const slots = await slottedRows(step, context, { run, stepId, rowsOf, door });
  // The workflows an `exists` check names, looked up the way tool:start-a-recipe-run finds a recipe: the person's own
  // row under any of their recipe row types, or a recipe the Workshop ships.
  const workflows = await knownWorkflows(step, context, door);
  const catalogs = { 'ran-job': job => takers.get(job) ?? null, 'slotted-run': (row, type) => slots.get(`${type}\n${row}`) ?? null, workflow: id => workflows.has(id) };
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
  // Every source a passing citation was judged against, with the head it held, so the kept answer says what it was judged on.
  const judgedAgainst = [...new Set([...looked.values()].flat().map(one => one.against).filter(Boolean))].sort();
  const value = { kind: JOB_KIND, status: 'done', row: parent.row, label: `${parent.label}: answer of ${step.title ?? step.id}`, parent: run, step: stepId, answer, finished_by: 'workflow:submit-a-recipe-step', kept_at: new Date().toISOString(), ...(judgedAgainst.length ? { judged_against: judgedAgainst } : {}) };
  await door.write([{ id, type: JOB_KIND, value }], { key: `${run}:${stepId}:answer` });
  return {
    status: 'kept', answer_id: id, ...(judgedAgainst.length ? { judged_against: judgedAgainst } : {}),
    checks: results.filter(result => result.passed).map(({ kind, says, passed }) => ({ kind, says, passed })),
    unchecked: results.filter(result => result.evaluated === false).map(({ kind, says, reason }) => ({ kind, says, reason })),
  };
}
