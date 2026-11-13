// tools/decide-with-a-method/read-data/workflow-runs.mjs
//
// A workflow run, read back and judged, so a decision that planned a workflow can name the run that did it. Ported from the
// old app's workflowRunProblems (src/decision-workflows.mjs: the run is a run of the planned workflow, on this account, and
// finished) with the one change the Workshop's runs need: a run is the `ai-job` record a recipe start writes
// (read-data/start-a-recipe-run.mjs in tools/workflows), `{ status, row, job: <the recipe's steps as run>, result }`, and
// it is finished only when its AI wrote `status: "done"` and a result that answers every step it was started with.
//
//   runProblem(door, workflowId, runId, { finished }) -> { word, parts }, a refusal for decide-with-a-method.json's words, or
//   null when the run passes. decisions.mjs says the words, so this module never imports it.
//
// The door is the person's own records, so a run that is not found there is not on this account. A step with a `submit`
// schema is answered when its result entry satisfies that schema as the run was started with it; a step without one
// (a recipe step that states a `done_when`) is answered when its result entry holds words. A schema keyword this does not
// judge is left to the AI that wrote the result, never counted as met.
const RUN_KIND = 'ai-job';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blank = value => value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0) || (object(value) && Object.keys(value).length === 0);

const typeOf = value => (Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value);
const isType = (value, type) => (type === 'number' ? typeof value === 'number' : type === 'integer' ? Number.isInteger(value) : typeOf(value) === type);

// What is wrong with a value against the schema's type, enum, string length, required fields and nested parts.
function schemaProblems(value, schema, path) {
  if (!object(schema)) return [];
  if (schema.type !== undefined && ![].concat(schema.type).some(type => isType(value, type))) return [`${path} is not ${[].concat(schema.type).join(' or ')}`];
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return [`${path} is not one of its allowed values`];
  if (typeof value === 'string' && schema.minLength !== undefined && value.trim().length < schema.minLength) return [`${path} is shorter than ${schema.minLength} characters`];
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return [`${path} has fewer than ${schema.minItems} items`];
    return value.flatMap((item, at) => schemaProblems(item, schema.items, `${path}[${at}]`));
  }
  if (!object(value)) return [];
  const missing = (schema.required ?? []).filter(name => value[name] === undefined).map(name => `${path}.${name} is missing`);
  return [...missing, ...Object.entries(schema.properties ?? {}).filter(([name]) => value[name] !== undefined).flatMap(([name, part]) => schemaProblems(value[name], part, `${path}.${name}`))];
}

// The result as an object: a run's AI may have written it as one or as the JSON text of one.
function resultOf(run) {
  if (object(run.result)) return run.result;
  if (typeof run.result !== 'string') return null;
  try { const parsed = JSON.parse(run.result); return object(parsed) ? parsed : null; } catch { return null; }
}

// Each step of the run that its result does not answer, with why, in the run's step order.
function stepProblems(run) {
  const result = resultOf(run);
  if (!result) return ['its result is not an object of step answers'];
  return run.job.flatMap(step => {
    const entry = result[step.id];
    if (blank(entry)) return [`${step.id} has no result`];
    return object(step.submit) ? schemaProblems(entry, step.submit, step.id) : [];
  });
}

export async function runProblem(door, workflowId, runId, { finished }) {
  const run = await door.read(RUN_KIND, runId);
  if (!object(run)) return { word: 'run_not_found', parts: { run: runId } };
  if (run.row !== workflowId) return { word: 'run_wrong_workflow', parts: { run: runId, workflow: workflowId, row: run.row ?? 'none' } };
  if (!finished) return null;
  if (run.status !== 'done') return { word: 'run_not_finished', parts: { run: runId, status: run.status ?? 'none' } };
  if (!Array.isArray(run.job) || run.job.length === 0 || !run.job.every(step => object(step) && typeof step.id === 'string')) return { word: 'run_no_steps', parts: { run: runId } };
  const problems = stepProblems(run);
  return problems.length ? { word: 'run_steps_unproved', parts: { run: runId, steps: problems.slice(0, 6).join('; ') } } : null;
}

// The run each workflow of a decision's plan is bound to: { bound: { workflow: run_id } } or { problem } for a refusal. `plan`
// is the accepted plan's items; `named` is what a call names ({ workflow: { run_id } }). A named workflow must be one the
// plan declared applicable, and may give only run_id.
export function boundRuns(plan, named, label) {
  const bound = {};
  for (const [workflow, item] of Object.entries(plan ?? {})) if (item?.applicable === true && typeof item.run_id === 'string') bound[workflow] = item.run_id;
  for (const [workflow, item] of Object.entries(object(named) ? named : {})) {
    if (plan?.[workflow]?.applicable !== true) return { problem: { word: 'run_not_planned', parts: { label: `${label}.${workflow}` } } };
    if (!object(item) || typeof item.run_id !== 'string' || !item.run_id.trim() || Object.keys(item).some(key => key !== 'run_id')) return { problem: { word: 'run_binding_shape', parts: { label: `${label}.${workflow}` } } };
    bound[workflow] = item.run_id;
  }
  return { bound };
}

// Every bound run as a finished run of its workflow; the refusals of all of them, in the order bound.
export async function unfinishedRuns(door, bound) {
  return (await Promise.all(Object.entries(bound).map(([workflow, runId]) => runProblem(door, workflow, runId, { finished: true })))).filter(Boolean);
}
