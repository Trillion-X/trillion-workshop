// A method names candidate workflows while planning. Applicability is decided against case evidence; only the
// declared applicable obligations are due later. A plan or a real run ID is never a completion receipt.
export const WORKFLOW_PLAN_VERSION = 1;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// Existing decisions and carried-out receipts can bind a run without a new endpoint or a duplicate workflow.
export const workflowBindingsSchema = {
  type: 'object',
  description: 'Optional existing run IDs for the applicable workflow obligations declared in the guided questions. Keys are workflow IDs; each value is {run_id}. The service verifies the account and recipe. A run ID does not say the run finished.',
  additionalProperties: { type: 'object', additionalProperties: false, required: ['run_id'], properties: { run_id: { type: 'string', minLength: 1 } } },
};

export function workflowObligations(record, { decision = record.decision, receipts = true, bindings = {} } = {}) {
  // Accepted answers from before phased planning keep their original meaning. No inferred migration from an old
  // run_id/skip answer; only the server installs this version when accepting a still-unanswered planning step.
  if (record.workflow_plan?.version !== WORKFLOW_PLAN_VERSION) return [];
  const items = record.workflow_plan.items;
  const refs = { ...items, ...(decision?.workflow_runs ?? {}) };
  if (receipts) for (const receipt of record.carried_out ?? []) {
    if (receipt.decision_generation === (record.decision_generation ?? 1)) Object.assign(refs, receipt.workflow_runs ?? {});
  }
  Object.assign(refs, bindings);
  return Object.entries(items).filter(([, item]) => item.applicable === true).map(([workflow_id, item]) => ({
    workflow_id, required_phase: item.required_phase, because: item.because, plan: item.plan, evidence_refs: item.evidence_refs,
    state: nonempty(refs[workflow_id]?.run_id) ? 'run_referenced' : 'planned',
    ...(nonempty(refs[workflow_id]?.run_id) ? { run_id: refs[workflow_id].run_id } : {}),
  }));
}

export function validateWorkflowBindings(record, bindings) {
  if (bindings === undefined) return;
  if (!object(bindings)) throw new Error('workflow_runs must map declared applicable workflow IDs to {run_id}');
  const applicable = new Set(workflowObligations(record).map(row => row.workflow_id));
  for (const [workflowId, item] of Object.entries(bindings)) {
    if (!applicable.has(workflowId)) throw new Error(`workflow_runs.${workflowId} is not a declared applicable obligation`);
    if (!object(item) || !nonempty(item.run_id) || Object.keys(item).some(key => key !== 'run_id')) throw new Error(`workflow_runs.${workflowId} must be {run_id}; a binding cannot change the accepted plan or its required phase`);
  }
}

// The lookup belongs to the account owner, never the caller. An explicit state wins over a legacy finished_at,
// as it does in workflows.mjs runState: a failed/working run cannot reuse an old timestamp as proof of completion.
export async function workflowRunProblems(bindings, readRun, { finished = false } = {}) {
  const entries = Object.entries(bindings ?? {}).filter(([, item]) => nonempty(item?.run_id));
  return (await Promise.all(entries.map(async ([workflowId, item]) => {
    const label = `workflow_runs.${workflowId}.run_id ${item.run_id}`;
    if (typeof readRun !== 'function') return `${label} cannot be verified: this host has no account-owned workflow run reader`;
    const run = await readRun(item.run_id);
    if (run?.recipe?.id !== workflowId) return `${label} is not a run of ${workflowId} on this account`;
    const state = run.state ?? (run.finished_at ? 'finished' : 'working');
    if (finished && state !== 'finished') return `${label} is ${state}, not finished; an existing or started run does not complete this obligation`;
    return null;
  }))).filter(Boolean);
}

export async function workflowPhaseProblems(record, phase, readRun, options = {}) {
  const due = workflowObligations(record, options).filter(row => phase === 'execution' || row.required_phase === 'decision');
  const missing = due.filter(row => !row.run_id).map(row => `${row.workflow_id} is planned and remains unfinished (${row.required_phase} phase); bind its actual run_id through ${phase === 'decision' ? 'decide.workflow_runs before deciding' : 'say_what_was_done.workflow_runs before verified completion'}`);
  const bindings = Object.fromEntries(due.filter(row => row.run_id).map(row => [row.workflow_id, { run_id: row.run_id }]));
  return [...missing, ...await workflowRunProblems(bindings, readRun, { finished: true })];
}
