// src/tool-transaction.mjs
//
// SEVERAL TOOL CALLS MADE TOGETHER: THE WHOLE STANDS, OR EVERY STEP ALREADY DONE IS PUT BACK.
//
// Purpose: an AI that must do several things that only make sense together (remove two files and a schedule; read, then change)
// should not leave half of them done when the third fails. A plan lists the steps; later steps may take values from earlier
// results; the first failure puts back, in reverse order, what was already done, and says what was and was not put back. The plan
// is data: references are paths, never code, so there is nothing to evaluate or escape.
//
// Non-negotiable invariants:
//   1. Before anything runs the plan is checked as a whole: step count, unique ids, known tools, references only to earlier steps,
//      and every step that is not last must be one that can be put back (reads, a result that carries its own undo, or a DATA row).
//   2. Steps run strictly in order, one at a time; a step's input is resolved from earlier results just before it runs.
//   3. A failure is a throw, or a result matching DATA `failed_when`; it stops the plan and puts back the done steps in reverse.
//   4. Putting back is the tool's own undo (the call in its result, or the DATA row's call); an undo that fails is reported, not hidden,
//      and the rest are still tried.
//   5. The limits, the failure test, the reversals and the words are DATA (./tool-transaction.json). No tool is named in this file.
//
// Key concept: `runTransaction({ steps, tools, invoke }, rules?)` -> { committed, results, failed, undone, not_undone, errors }.
//   `tools`: [{ name, annotations }]; `invoke(name, input)` -> the tool's result.
import rules from '../../shared-code/src/tool-transaction.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The value at `path` (dot keys, `[*]` over a list) in `root`, or { missing: true }. */
function pick(root, path, depthMost) {
  const parts = path.split('.');
  if (parts.length > depthMost) return { missing: true };
  let here = [root];
  let projected = false;
  for (const part of parts) {
    const star = part.endsWith('[*]');
    const key = star ? part.slice(0, -3) : part;
    const next = [];
    for (const item of here) {
      // Only a value's own keys are results: a path through __proto__ or constructor reaches nothing.
      const value = key === '' ? item : (isObject(item) || Array.isArray(item)) && Object.hasOwn(item, key) ? item[key] : undefined;
      if (value === undefined) return { missing: true };
      if (star) { if (!Array.isArray(value)) return { missing: true }; next.push(...value); projected = true; } else next.push(value);
    }
    here = next;
  }
  return { value: projected ? here : here[0] };
}

/** Every `{ $from }` in `value`, replaced from `scopes` ({ [name]: { result, input } }). Throws { unresolved } on a path that is not there. */
function resolve(value, scopes, settings) {
  if (Array.isArray(value)) return value.map((item) => resolve(item, scopes, settings));
  if (!isObject(value)) return value;
  if (typeof value.$from === 'string' && Object.keys(value).length === 1) {
    const [scope, ...rest] = value.$from.split('.');
    const found = scopes[scope] === undefined ? { missing: true } : pick(scopes[scope], rest.join('.'), settings.limits.path_depth);
    if (found.missing) throw Object.assign(new Error('unresolved'), { unresolved: value.$from });
    return found.value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolve(inner, scopes, settings)]));
}

const failureOf = (result, settings) => {
  if (!isObject(result)) return null;
  for (const test of settings.failed_when) {
    const found = result[test.field];
    if (test.present && found !== undefined && found !== null) return `${test.field}: ${typeof found === 'string' ? found : JSON.stringify(found)}`;
    if (test.equals !== undefined && found === test.equals) return `${test.field} is ${JSON.stringify(test.equals)}`;
    if (test.not_empty && Array.isArray(found) && found.length > 0) return `${test.field}: ${JSON.stringify(found).slice(0, 200)}`;
  }
  return null;
};

/** The call that puts a done step back, from its result or from the DATA row for its tool; null when there is none. */
function reverseCall(step, result, settings) {
  for (const field of settings.reverse_result_fields) {
    const call = result?.[field];
    if (isObject(call) && typeof call.tool === 'string') return { tool: call.tool, input: call.arguments ?? call.input ?? {} };
  }
  const row = settings.reversals.find((candidate) => candidate.tool === step.tool);
  if (!row?.undo) return null;
  try { return { tool: row.undo.tool, input: resolve(row.undo.input, { result, input: step.input ?? {} }, settings) }; } catch { return null; }
}

/** Checks a plan as a whole. -> a list of { code, message } (empty when it can run). */
function checkPlan(steps, tools, settings) {
  const say = (code, values = {}) => ({ code, message: fill(settings.words.errors[code], values) });
  if (!Array.isArray(steps) || !steps.length) return [say('NOT_A_PLAN')];
  if (steps.length > settings.limits.steps) return [say('TOO_MANY_STEPS', { most: settings.limits.steps })];
  const known = new Map(tools.map((tool) => [tool.name, tool]));
  const errors = [];
  const seen = new Set();
  steps.forEach((step, index) => {
    if (!isObject(step) || typeof step.id !== 'string' || !step.id || typeof step.tool !== 'string' || (step.input !== undefined && !isObject(step.input))) { errors.push(say('BAD_STEP', { index: index + 1 })); return; }
    if (seen.has(step.id)) errors.push(say('DUPLICATE_ID', { id: step.id }));
    const tool = known.get(step.tool);
    if (!tool) { errors.push(say('UNKNOWN_TOOL', { id: step.id, tool: step.tool })); seen.add(step.id); return; }
    if (step.tool === settings.tool_name) errors.push(say('NESTED', { id: step.id }));
    const reads = tool.annotations?.readOnlyHint === true;
    const reversible = reads || settings.reversals.some((row) => row.tool === step.tool);
    if (index < steps.length - 1 && !reversible) errors.push(say('CANNOT_BE_PUT_BACK', { id: step.id, tool: step.tool }));
    for (const reference of JSON.stringify(step.input ?? {}).matchAll(/"\$from":"([^"]+)"/gu)) {
      if (!seen.has(reference[1].split('.')[0])) errors.push(say('BAD_REFERENCE', { id: step.id, from: reference[1] }));
    }
    seen.add(step.id);
  });
  return errors;
}

/** Runs the plan. `tools` carry name and annotations; `invoke(name, input)` runs one. */
export async function runTransaction({ steps, tools, invoke }, settings = rules) {
  const errors = checkPlan(steps, tools, settings);
  if (errors.length) return { committed: false, results: {}, failed: null, undone: [], not_undone: [], errors };
  const results = {};
  const done = [];
  const scopes = {};
  let failed = null;
  for (const step of steps) {
    let input;
    try { input = resolve(step.input ?? {}, scopes, settings); } catch (error) {
      failed = { step: step.id, tool: step.tool, code: 'REFERENCE_UNRESOLVED', why: fill(settings.words.errors.REFERENCE_UNRESOLVED, { id: step.id, from: error.unresolved }) };
      break;
    }
    try {
      const result = await invoke(step.tool, input);
      const why = failureOf(result, settings);
      if (why) {
        // A step that reports a refusal may still have done part of its work; keep it so it can be put back.
        done.push({ step: { ...step, input }, result, failedItself: true });
        failed = { step: step.id, tool: step.tool, code: 'STEP_FAILED', why: fill(settings.words.errors.STEP_FAILED, { id: step.id, tool: step.tool, why }) };
        break;
      }
      results[step.id] = result;
      scopes[step.id] = { result, input };
      done.push({ step: { ...step, input }, result });
    } catch (error) {
      failed = { step: step.id, tool: step.tool, code: 'STEP_FAILED', why: fill(settings.words.errors.STEP_FAILED, { id: step.id, tool: step.tool, why: String(error?.message ?? error) }) };
      break;
    }
  }
  if (!failed) return { committed: true, results, failed: null, undone: [], not_undone: [], errors: [] };
  const undone = [];
  const notUndone = [];
  const readOnly = new Set(tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name));
  for (const { step, result, failedItself } of done.reverse()) {
    if (readOnly.has(step.tool)) continue;
    const call = reverseCall(step, result, settings);
    // The step that failed is only put back when its own answer says how; it reported a failure, so no more is claimed.
    if (!call && failedItself) continue;
    if (!call) { notUndone.push({ step: step.id, tool: step.tool, why: 'nothing says how to put it back' }); continue; }
    try {
      const answer = await invoke(call.tool, call.input);
      const why = failureOf(answer, settings);
      if (why) notUndone.push({ step: step.id, tool: step.tool, why }); else undone.push({ step: step.id, tool: step.tool, with: call.tool });
    } catch (error) { notUndone.push({ step: step.id, tool: step.tool, why: String(error?.message ?? error) }); }
  }
  return { committed: false, results, failed, undone, not_undone: notUndone, errors: [] };
}
