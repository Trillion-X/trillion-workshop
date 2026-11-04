// src/workflow-step-versions.mjs
//
// Purpose: per-step definition versions for workflows (src/workflows.mjs). A step that runs a Marketplace tool keeps a
// pin of the tool definition it was written for; a run uses the tool as it is now only while the step's contract
// (DATA: workflow-step-versions.json contract_fields) is unchanged, and otherwise waits until the owner upgrades the
// step. Upgrading is an explicit operation over this account's saved recipe.
//
// Non-Negotiable Invariants:
//   1. A pin is { version, fields: { <contract field>: identity } }: BLAKE3 identities of the tool's definition
//      (typed-operation-contract workshopToolVersion) and of each contract field, so a dumb reader compares them.
//   2. Both recipe forms are read the same way: ordered steps pin at `run_tool.pinned`, an engine definition's ask
//      step at `config.context.pinned`, which is where the run host reads every ask's context.
//   3. Saving fills a missing pin and never moves a pin that is already there; only upgradedRecipe moves one.
//   4. An upgrade that would leave a required tool input without a value is refused, every problem at once.
//   5. Nothing here names a tool, a step or a field: the contract fields and the words are DATA.
import settings from './workflow-step-versions.json' with { type: 'json' };
import { identityOf, workshopToolVersion } from './typed-operation-contract.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const say = (key, values) => settings.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const PIN = /^1f:[a-f0-9]{64}$/;

/** The pin of a tool definition as it is now. */
export function pinOf(descriptor) {
  return { version: workshopToolVersion(descriptor), fields: Object.fromEntries(settings.contract_fields.map(field => [field, `1f:${identityOf(descriptor?.[field] ?? null)}`])) };
}

/** Every problem with a pin a caller sent; none for a step with no pin. */
export function pinProblems(pinned, name) {
  if (pinned === undefined) return [];
  if (!object(pinned) || !PIN.test(pinned.version ?? '') || !object(pinned.fields) || !Object.values(pinned.fields).every(value => PIN.test(value ?? ''))) {
    return [`${name} must be { version: "1f:...", fields: { field: "1f:..." } }, as describe_workflow shows it; leave it out and saving fills it in.`];
  }
  return [];
}

/** Every tool step of a recipe, in either form: { step_id, tool_id, pinned, input }. */
export function toolStepsOf(row) {
  if (object(row?.definition)) {
    return (row.definition.steps ?? []).filter(step => step?.kind === 'ask' && typeof step.config?.name === 'string' && step.config.name.startsWith('tool:'))
      .map(step => ({ step_id: step.id, tool_id: step.config.name, pinned: step.config.context?.pinned, input: step.config.input }));
  }
  return (row?.steps ?? []).filter(step => typeof step?.run_tool?.tool_id === 'string')
    .map(step => ({ step_id: step.id, tool_id: step.run_tool.tool_id, pinned: step.run_tool.pinned, input: step.run_tool.input }));
}

// The recipe with `pins` ({ step_id: pin }) written at each step's own place.
function withPins(row, pins) {
  if (object(row.definition)) {
    return { ...row, definition: { ...row.definition, steps: row.definition.steps.map(step => (Object.hasOwn(pins, step?.id)
      ? { ...step, config: { ...step.config, context: { ...(object(step.config.context) ? step.config.context : {}), pinned: pins[step.id] } } } : step)) } };
  }
  return { ...row, steps: row.steps.map(step => (Object.hasOwn(pins, step?.id) ? { ...step, run_tool: { ...step.run_tool, pinned: pins[step.id] } } : step)) };
}

/** The steps as they would be without any pin: what a comparison of two recipes' work reads. */
export function withoutPins(steps) {
  return (steps ?? []).map(step => {
    if (!object(step?.run_tool) || step.run_tool.pinned === undefined) return step;
    const { pinned: _pinned, ...run_tool } = step.run_tool;
    return { ...step, run_tool };
  });
}

/** How a pin stands against the tool as it is now: which contract fields changed, and whether the step may run. */
export function compareToPin(pinned, descriptor) {
  const current = pinOf(descriptor);
  const changed_fields = settings.contract_fields.filter(field => (pinned.fields?.[field] ?? null) !== current.fields[field]);
  return { pinned, current, version_changed: pinned.version !== current.version, changed_fields, runs: changed_fields.length === 0 };
}

/** What a run's step says while it waits for an upgrade. */
export function upgradeNeeded({ workflow_id, step_id, tool_id, compared }) {
  return { tool_id, state: 'upgrade_needed', pinned: compared.pinned.version, current: compared.current.version, changed_fields: compared.changed_fields,
    error: say('upgrade_needed', { step_id, tool_id, fields: compared.changed_fields.join(', ') }),
    next_call: { tool: 'upgrade_workflow_steps', arguments: { workflow_id, step_ids: [step_id] } } };
}

// describe: (tool_id) → the tool's descriptor as this account reads it now, or null when the host answers none.
/** The recipe with every missing pin filled in from the tools as they are now. */
export async function pinnedRecipe(row, describe) {
  const pins = {};
  for (const step of toolStepsOf(row)) {
    if (step.pinned !== undefined) continue;
    const descriptor = await describe(step.tool_id);
    if (descriptor) pins[step.step_id] = pinOf(descriptor);
  }
  return Object.keys(pins).length ? withPins(row, pins) : row;
}

/** Each tool step's version against the tool now, as describe_workflow shows it. */
export async function stepVersionsOf(row, describe) {
  const shown = [];
  for (const step of toolStepsOf(row).slice(0, settings.most_steps_per_upgrade)) {
    let descriptor;
    try { descriptor = await describe(step.tool_id); } catch (error) { shown.push({ step_id: step.step_id, tool_id: step.tool_id, pinned: step.pinned?.version ?? null, current: null, error: String(error?.message ?? error) }); continue; }
    if (!descriptor) { shown.push({ step_id: step.step_id, tool_id: step.tool_id, pinned: step.pinned?.version ?? null, current: null }); continue; }
    if (step.pinned === undefined) { shown.push({ step_id: step.step_id, tool_id: step.tool_id, pinned: null, current: pinOf(descriptor).version, follows_current: true }); continue; }
    const compared = compareToPin(step.pinned, descriptor);
    shown.push({ step_id: step.step_id, tool_id: step.tool_id, pinned: compared.pinned.version, current: compared.current.version,
      upgrade_available: compared.version_changed, ...(compared.changed_fields.length ? { changed_fields: compared.changed_fields, waits_for_upgrade: true } : {}) });
  }
  return shown;
}

// The inputs a tool requires that a step's input gives no value for (a literal, a binding, or the tool's own fixed_input).
function missingInputs(input, descriptor) {
  const given = new Set([...Object.keys(object(input) ? input : {}), ...Object.keys(object(descriptor?.fixed_input) ? descriptor.fixed_input : {})]);
  return (Array.isArray(descriptor?.input_schema?.required) ? descriptor.input_schema.required : []).filter(name => !given.has(name));
}

/**
 * Moves the named steps (every tool step when step_ids is empty) to the tools as they are now.
 * Returns { row, upgraded: [{ step_id, tool_id, from, to, changed_fields }], problems }.
 */
export async function upgradedRecipe(row, describe, step_ids = []) {
  const steps = toolStepsOf(row);
  const named = Array.isArray(step_ids) && step_ids.length ? step_ids : steps.map(step => step.step_id);
  const problems = named.filter(id => !steps.some(step => step.step_id === id)).map(id => `${id} is not a step of ${row.id} that runs a tool.`);
  if (named.length > settings.most_steps_per_upgrade) problems.push(`One upgrade moves at most ${settings.most_steps_per_upgrade} steps.`);
  const pins = {};
  const upgraded = [];
  for (const step of steps.filter(item => named.includes(item.step_id))) {
    const descriptor = await describe(step.tool_id);
    if (!descriptor) { problems.push(`${step.tool_id} (step ${step.step_id}) cannot be read now, so its step cannot move to it.`); continue; }
    const now = pinOf(descriptor);
    if (step.pinned?.version === now.version) continue;
    const missing = missingInputs(step.input, descriptor);
    if (missing.length) { problems.push(say('upgrade_refused', { step_id: step.step_id, tool_id: step.tool_id, missing: missing.join(', ') })); continue; }
    pins[step.step_id] = now;
    upgraded.push({ step_id: step.step_id, tool_id: step.tool_id, from: step.pinned?.version ?? null, to: now.version,
      changed_fields: step.pinned ? compareToPin(step.pinned, descriptor).changed_fields : settings.contract_fields });
  }
  return { row: problems.length || !upgraded.length ? row : withPins(row, pins), upgraded, problems,
    ...(problems.length || upgraded.length ? {} : { note: say('nothing_to_upgrade', { workflow_id: row.id }) }) };
}

export const runsKeepWords = () => settings.words.runs_keep;
