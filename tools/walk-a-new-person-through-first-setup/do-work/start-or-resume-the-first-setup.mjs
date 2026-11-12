// tools/walk-a-new-person-through-first-setup/do-work/start-or-resume-the-first-setup.mjs
//
// tool:start-or-resume-the-first-setup, run as a function in the tool container:
//
//   node do-work/start-or-resume-the-first-setup.mjs < <the input as JSON>
//
// and prints { result } on its last line (or { error } with exit 1). It answers what the setup start does next, as an
// ordered list of owner calls. It writes nothing: the caller runs each call that is `status: call`, reads the saved setup
// back with `read_back` before the next step, and records each finished step in `done_steps` on the next ask.
//
// Port of old trillion src/setup-runtime.mjs `ensure()` (the order defaults, event intake, workflow, timed work) and its
// refusal rules (a stopped setup is not restarted without restart; a failed or stuck run resumes; a finished one has
// nothing to start). Each owner is the Workshop tool that does that step; a step whose owner is not in `available_tools`
// (the caller's tools:list) is marked unavailable and is never called.
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The owner of each prepare step, in the order the old ensure() runs them.
const STEPS = [
  { id: 'defaults', owner: 'tool:give-every-account-ready-made-workflows-and-defaults' },
  { id: 'event_intake', owner: null },
  { id: 'workflow', owner: 'tool:start-a-recipe-run' },
  { id: 'timed_work', owner: 'tool:run-at-a-time' },
];
const READ_BACK = 'tool:read-setup';
const WORKFLOW_KEY = 'account-setup:v1';
const DONE_STEPS = STEPS.map(step => step.id);

export function startOrResumeTheFirstSetup(input) {
  if (!object(input)) throw new Error('Send one JSON object: { account_id, available_tools, runtime, prerequisites?, done_steps?, restart? }.');
  if (!object(input.runtime)) throw new Error('runtime is the saved setup run: { workflow: { exists, state, run_id? } }.');
  if (typeof input.account_id !== 'string' || !input.account_id) throw new Error('account_id names the account whose setup this is.');
  if (!Array.isArray(input.available_tools) || !input.available_tools.every(tool => typeof tool === 'string')) {
    throw new Error('available_tools is the list of Workshop tool ids the caller found in the catalogue.');
  }
  if (input.done_steps !== undefined && (!Array.isArray(input.done_steps) || !input.done_steps.every(id => DONE_STEPS.includes(id)))) {
    throw new Error(`done_steps names steps already read back: ${DONE_STEPS.join(', ')}.`);
  }
  const workflow = input.runtime.workflow ?? { exists: false, state: 'not_started' };
  const prerequisites = object(input.prerequisites) ? input.prerequisites : {};
  const done = new Set(input.done_steps ?? []);
  const readBack = { tool: READ_BACK, input: { account_id: input.account_id } };
  const base = { schema: 'trillion.setup-start/v1', account_id: input.account_id, wrote: false };

  // A deliberate stop is never restarted by this tool; only an explicit restart asks for a new start.
  if (prerequisites.setup_paused === true && input.restart !== true) return { ...base, action: 'stopped', steps: [], next: null };
  if (workflow.exists === true && workflow.state === 'finished') return { ...base, action: 'finished', steps: [], next: null };

  const resuming = workflow.exists === true && ['failed', 'stuck'].includes(workflow.state);
  const action = resuming ? 'resume' : 'start';
  const steps = STEPS.map(step => {
    if (done.has(step.id)) return { id: step.id, status: 'done', owner: step.owner };
    if (!step.owner || !input.available_tools.includes(step.owner)) return { id: step.id, status: 'unavailable', owner: step.owner };
    const call = step.id === 'workflow'
      ? { tool: step.owner, input: { request_key: WORKFLOW_KEY, ...(resuming ? { run_id: workflow.run_id, resume: true } : {}) } }
      : { tool: step.owner, input: { account_id: input.account_id } };
    return { id: step.id, status: 'call', owner: step.owner, call, read_back: readBack };
  });
  const next = steps.find(step => step.status === 'call')?.id ?? null;
  return { ...base, action, steps, next };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { readFileSync } = await import('node:fs');
  try {
    process.stdout.write(JSON.stringify({ result: startOrResumeTheFirstSetup(JSON.parse(readFileSync(0, 'utf8') || '{}')) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
