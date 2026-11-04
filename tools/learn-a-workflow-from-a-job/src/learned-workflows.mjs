// src/learned-workflows.mjs
//
// PURPOSE
//   A process an AI works out once becomes a workflow every AI finds and runs again. When an AI finishes a job in which
//   several tools ran and finished (the run record: the tool runs kept for that job), this file turns that record into
//   a workflow row (src/workflows.mjs save_workflow's shape): one step per tool that ran, in order, each saying which
//   tool and the input it ran with last time, then a last step saying what was delivered. A later run of the same job
//   that took different steps improves the same workflow in place, and the versions before it are kept in the row.
//   It also reads, from a finished job, which spaces it was done in (so the workflow goes there too) and whether the
//   job stopped without its result (so it is handed on as open work with the exact wall).
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no tool, app, vendor, site or person. Which tool ran comes from the run record; every number and
//      word is DATA (src/learned-workflows.json).
//   2. Pure: no store, no network, no clock except the `now` it is given. The person's store reads the run record and
//      saves the row through the one workflow owner (makeWorkflows.save), so a learned workflow is an ordinary saved
//      workflow: private by default, found by find_workflow, run by start_workflow, shared with share_to_space.
//   3. Only tool runs that finished count. A run record with fewer than `min_tool_runs` of them teaches nothing.
//   4. A file's identity in an input is never written into the workflow's words; the step says the job's own file
//      goes there. Inputs are cut to `max_input_chars`.
//   5. The same steps again change nothing (no new version); different steps make a new version and keep the earlier
//      one's steps, source and identity in `versions` (at most `keep_versions`).
//   6. The generic shape a learned job shares with every account (publicShape) carries nothing of the job itself: no
//      value it ran with, none of the person's words, no outcome and no handoff. Its words come only from the tools'
//      own public descriptors and `words`; each step names its tool as `run_tool`, so Trillion runs it, with each input
//      bound to the workflow's own input (its schema copied from the tool's) or to an earlier step's result when the
//      value the job used was that result. It is refused, with every reason, when a tool did not finish, only this
//      account can run a tool, a tool's result is not an object a later step can read, or any value the job ran with,
//      any of its words or anything key-shaped would appear in it. Those checks are run on the finished row itself.
//
import settings from './learned-workflows.json' with { type: 'json' };
import { withoutSecrets } from './scheduler.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fill = (words, values) => String(words).replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
const FILE = /^1f:[0-9a-f]{64}$/;

/** Words to an id fragment: lowercase letters, numbers and single dashes, at most 48 characters. */
export function slugOf(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'job';
}

/** The input a tool ran with, as the words a step shows: files named as the job's own file, long text cut. */
export function inputSketch(input, words = settings.words, max = settings.max_input_chars) {
  const shown = value => (typeof value === 'string' && FILE.test(value) ? words.file_value
    : Array.isArray(value) ? value.map(shown)
      : object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shown(item)]))
        : value);
  const text = JSON.stringify(shown(input ?? {}));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The finished tool runs of a run record, in order, with an immediate repeat of the same tool and input kept once. */
export function finishedRuns(runs) {
  const kept = [];
  for (const run of runs ?? []) {
    if (!object(run) || run.state !== 'completed' || typeof run.tool_id !== 'string' || !run.tool_id.startsWith('tool:')) continue;
    const last = kept.at(-1);
    if (last && last.tool_id === run.tool_id && JSON.stringify(last.input ?? {}) === JSON.stringify(run.input ?? {})) continue;
    kept.push(run);
  }
  return kept;
}

const toolSequence = steps => (steps ?? []).map(step => step.learned_tool ?? null).filter(Boolean).join('>');

/**
 * The workflow a finished job teaches, or null when it teaches nothing.
 *   job      what the job was, in plain words (the handoff's said or job, or what the AI says it did)
 *   runs     the run record: [{ task_id, tool_id, label?, input, state }] in the order they ran
 *   source   where it was learned: { handoff_id?, app?, agent? }
 *   earlier  the learned workflow this improves, when there is one (a saved row), else null
 *   id       the id to save under when there is no earlier one
 *   made_from  the workflow this one improves when it is someone else's (shared in a space), so its lineage shows
 * Returns { row, change: 'new' | 'improved' | 'same' }.
 */
export function learnedRecipe({ job, runs, source = {}, earlier = null, id = null, made_from = null, recipeIdentity = () => null, now = new Date() }) {
  const words = settings.words;
  const done = finishedRuns(runs);
  if (done.length < settings.min_tool_runs || typeof job !== 'string' || !job.trim()) return null;
  const said = job.trim().replace(/\s+/g, ' ').slice(0, 300);
  const steps = done.map((run, index) => ({
    id: `step-${index + 1}`,
    title: fill(words.step_title, { tool: run.label ?? run.tool_id }),
    do: fill(words.step_do, { tool_id: run.tool_id, input: inputSketch(run.input) }),
    submit: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string', minLength: 1 } } },
    learned_tool: run.tool_id,
  }));
  steps.push({ id: 'result', title: words.result_title, do: words.result_do, submit: { type: 'object', required: ['delivered'], properties: { delivered: { type: 'string', minLength: 3 } } } });
  // How it was learned, carried in the row so every member who finds it reads it from the owner's live copy: the job,
  // each run's tool and input (as the steps show them) and what the job delivered, never more than the steps already say.
  const learned_from = {
    ...(source.handoff_id ? { handoff_id: source.handoff_id } : {}), ...(source.app ? { app: source.app } : {}),
    job: said, task_ids: done.map(run => run.task_id).filter(Boolean),
    runs: done.map(run => ({ tool_id: run.tool_id, ...(run.label ? { label: run.label } : {}), input: inputSketch(run.input) })),
    ...(typeof source.outcome === 'string' && source.outcome.trim() ? { outcome: source.outcome.trim().slice(0, settings.max_outcome_chars) } : {}),
    learned_at: now.toISOString(),
  };
  if (earlier && toolSequence(earlier.steps) === toolSequence(steps)) return { row: earlier, change: 'same' };
  const version = earlier ? (Number(earlier.version) || 1) + 1 : 1;
  const versions = earlier
    ? [...(earlier.versions ?? []), { version: Number(earlier.version) || 1, recipe_identity: recipeIdentity(earlier), saved_at: earlier.saved_at ?? null, learned_from: earlier.learned_from ?? null, steps: (earlier.steps ?? []).map(step => step.title) }].slice(-settings.keep_versions)
    : [];
  const row = {
    id: earlier?.id ?? id ?? `${settings.id_prefix}${slugOf(said)}`,
    label: fill(words.label, { job: said }).slice(0, 120),
    job: fill(words.job, { job: said }),
    input_schema: { type: 'object', properties: { request: { type: 'string', description: 'This job\'s own details, in plain words' } } },
    steps,
    ...(made_from || earlier?.made_from ? { made_from: [...new Set([...(earlier?.made_from ?? []), ...(made_from ? [made_from] : [])])] } : {}),
    learned_from,
    version,
    ...(versions.length ? { versions } : {}),
  };
  return { row, change: earlier ? 'improved' : 'new' };
}

// Every string inside a value (with `keys`, its keys too), so a check can read all a row says.
function stringsIn(value, keys = false, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, keys, found);
  else if (object(value)) for (const [key, item] of Object.entries(value)) { if (keys) found.push(key); stringsIn(item, keys, found); }
  return found;
}

// Where `wanted` sits inside an earlier result, as a path a workflow step binds ("*" steps into a list, first item
// only), or null.
function pathTo(output, wanted, at = []) {
  if (output === wanted) return at;
  if (Array.isArray(output)) return output.length ? pathTo(output[0], wanted, [...at, '*']) : null;
  if (object(output)) {
    for (const [key, item] of Object.entries(output)) {
      const found = pathTo(item, wanted, [...at, key]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The generic shape of a learned job that any account finds and runs, or why it cannot be shared.
 *   runs       the run record with each run's result: [{ task_id, tool_id, label?, input, output, state }] in order
 *   tools      { [tool_id]: { made_by, descriptor } } as the Workshop describes each tool, or a missing entry when it
 *              could not be read
 *   job        the person's words for the job, used only to check none of them reach the shape
 *   id_suffix  this account's maker id: with the tools in order it names the shape, so two chains never share an id
 * Returns { row, tools: [tool ids in order] } or { refused: [reasons] }.
 */
export function publicShape({ runs, tools = {}, job = '', id_suffix = null }) {
  const words = settings.words;
  const publish = settings.publish;
  const done = finishedRuns(runs);
  if (done.length < settings.min_tool_runs) return { refused: [fill(words.refused_few_runs, { min: settings.min_tool_runs })] };
  const refused = [];
  for (const run of done) {
    const tool = tools[run.tool_id];
    if (!object(tool?.descriptor)) refused.push(fill(words.refused_unknown_tool, { tool_id: run.tool_id }));
    else if (tool.made_by === 'this account' && !tool.descriptor.published_at) refused.push(fill(words.refused_own_tool, { tool_id: run.tool_id }));
    else if (tool.descriptor.output_schema?.type !== 'object') refused.push(fill(words.refused_output_shape, { tool_id: run.tool_id }));
  }
  if (refused.length) return { refused: [...new Set(refused)] };
  const properties = {};
  const required = [];
  // A generated step name must not shadow a real field supplied by any tool in this chain. Reserve the complete
  // source namespace before assigning aliases, then use deterministic numbered suffixes for the rare overlap.
  const reserved = new Set(done.flatMap(run => {
    const schema = tools[run.tool_id].descriptor.input_schema;
    return [...Object.keys(object(schema?.properties) ? schema.properties : {}), ...Object.keys(object(run.input) ? run.input : {})];
  }));
  const assigned = new Set();
  const fieldName = (key, index) => {
    const base = Object.hasOwn(properties, key) || assigned.has(key) ? `step${index + 1}_${key}` : key;
    let name = base;
    let suffix = 2;
    while (assigned.has(name) || (name !== key && reserved.has(name))) name = `${base}_${suffix++}`;
    assigned.add(name);
    return name;
  };
  const steps = done.map((run, index) => {
    const descriptor = tools[run.tool_id].descriptor;
    const schema = object(descriptor.input_schema?.properties) ? descriptor.input_schema.properties : {};
    const needed = new Set(Array.isArray(descriptor.input_schema?.required) ? descriptor.input_schema.required : []);
    const input = {};
    for (const [key, value] of Object.entries(object(run.input) ? run.input : {})) {
      // Only a long enough text is taken as an earlier result: a short word or a number matches by chance.
      const chained = typeof value === 'string' && value.length >= publish.min_chained_chars
        ? done.slice(0, index).map((earlier, at) => ({ at, path: pathTo(earlier.output, value) })).reverse().find(item => item.path)
        : null;
      if (chained) { input[key] = { from: ['steps', `step-${chained.at + 1}`, ...chained.path] }; continue; }
      const name = fieldName(key, index);
      properties[name] = object(schema[key]) ? schema[key] : {};
      if (needed.has(key)) required.push(name);
      input[key] = { from: ['input', name] };
    }
    return {
      id: `step-${index + 1}`,
      title: fill(words.step_title, { tool: descriptor.label ?? run.tool_id }),
      do: fill(words.shape_step_do, { tool_id: run.tool_id }),
      run_tool: { tool_id: run.tool_id, input },
      submit: { type: 'object' },
    };
  });
  const descriptors = done.map(run => tools[run.tool_id].descriptor);
  const labels = descriptors.map((descriptor, index) => descriptor.label ?? done[index].tool_id);
  const row = {
    // Its tools in order and the account that shares it name it, so one account's chain keeps one id however its labels read.
    id: `${publish.id_prefix}${slugOf(labels.join(' '))}-${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([done.map(run => run.tool_id), id_suffix ?? null])))).slice(0, 8)}`,
    label: fill(words.shape_label, { tools: labels.join(words.shape_joiner) }).slice(0, 120),
    job: fill(words.shape_job, { jobs: descriptors.map((descriptor, index) => String(descriptor.job ?? labels[index]).trim().replace(/[.\s]+$/, '')).join(words.shape_joiner) }),
    input_schema: { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}) },
    steps,
  };
  // The checks run on the row itself: a string not found in any tool's own public descriptor or in `words` is
  // searched for every value the job ran with, the job's own words and anything key-shaped.
  const known = JSON.stringify([descriptors, words]);
  const { id: _id, ...said } = row;
  const own = stringsIn(said, true).filter(text => !known.includes(text));
  const ranWith = done.flatMap(run => stringsIn(run.input)).filter(text => text.length >= publish.min_private_chars && !known.includes(text));
  const jobWords = String(job ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(word => word.length >= publish.min_private_chars && !known.toLowerCase().includes(word)) ?? [];
  const shown = JSON.stringify(row).toLowerCase();
  if (ranWith.some(value => shown.includes(value.toLowerCase())) || jobWords.some(word => shown.includes(word))) refused.push(words.refused_private_value);
  if (own.some(text => withoutSecrets(text) !== text.slice(0, 300))) refused.push(words.refused_secret);
  if (refused.length) return { refused };
  return { row, tools: done.map(run => run.tool_id) };
}

/** The spaces a finished job says it was done in (settings.scope_from paths inside the handoff). */
export function spacesOf(handoff) {
  const found = [];
  for (const path of settings.scope_from) {
    let value = handoff;
    for (const key of path) value = object(value) ? value[key] : undefined;
    for (const item of Array.isArray(value) ? value : [value]) if (typeof item === 'string' && item.trim()) found.push(item.trim());
  }
  return [...new Set(found)];
}

/** The exact wall when a finished result says the work stopped without its result, else null. */
export function wallOf(result) {
  if (!object(result)) return null;
  const state = String(result.state ?? result.status ?? '').toLowerCase().trim();
  if (!settings.failed_states.includes(state)) return null;
  const wall = [result.wall, result.in_the_way, result.error, result.reason, result.outcome, result.summary].find(value => typeof value === 'string' && value.trim());
  return (wall ?? state).trim().slice(0, 1000);
}

export const learnedSettings = settings;
export const learnedWords = (key, values = {}) => fill(settings.words[key], values);
