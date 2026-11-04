// src/workflow-authoring-guidance.mjs
//
// Purpose: field-level guidance for workflows an AI writes (save_workflow, src/workflows.mjs). The guidance is DATA
// (workflow-authoring-guidance.json): `fields` become the descriptions of save_workflow's input schema, and `notes`
// are what a saved workflow is checked for, returned with the save as authoring_notes.
//
// Non-Negotiable Invariants:
//   1. Guidance never refuses a save: recipeProblems (src/workflows.mjs) alone decides what cannot be kept.
//   2. Each note names the field it is about as a list of keys, so a caller finds it without parsing words.
//   3. The note kinds are the module's physics (what is measured); every limit, path and word is DATA.
import guidance from './workflow-authoring-guidance.json' with { type: 'json' };
import { toolStepsOf } from './workflow-step-versions.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const say = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** A copy of `schema` with each DATA field's guidance as its description. */
export function withFieldGuidance(schema) {
  const copy = structuredClone(schema);
  for (const { schema_path, says } of guidance.fields) {
    let at = copy;
    for (const key of schema_path) at = object(at) ? at[key] : undefined;
    if (object(at)) at.description = says;
  }
  return copy;
}

// Every value at a path of keys, where "*" is every item of a list, with the concrete path it was found at.
function valuesAt(value, path, where = []) {
  if (!path.length) return [{ value, at: where }];
  const [key, ...rest] = path;
  if (key === '*') return Array.isArray(value) ? value.flatMap((item, index) => valuesAt(item, rest, [...where, index])) : [];
  return object(value) && Object.hasOwn(value, key) ? valuesAt(value[key], rest, [...where, key]) : [];
}

// Every { from | all_from | values } path an input template reads.
function boundPaths(template) {
  if (Array.isArray(template)) return template.flatMap(boundPaths);
  if (!object(template)) return [];
  const own = [template.from, template.all_from, template.$kind === 'binding' ? template.values : undefined].filter(Array.isArray);
  return [...own, ...Object.values(template).flatMap(boundPaths)];
}

const isBinding = value => object(value) && (Array.isArray(value.from) || Array.isArray(value.all_from) || value.$kind === 'binding');

const measures = {
  longer_than: (note, workflow) => valuesAt(workflow, note.at).filter(({ value }) => typeof value === 'string' && value.length > note.chars).map(({ at }) => ({ at, says: note.says })),
  input_not_declared: (note, workflow) => {
    const declared = new Set(Object.keys(workflow.input_schema?.properties ?? {}));
    const read = new Set(toolStepsOf(workflow).flatMap(step => boundPaths(step.input)).filter(path => path[0] === 'input' && typeof path[1] === 'string').map(path => path[1]));
    return [...read].filter(name => !declared.has(name)).map(name => ({ at: ['input_schema', 'properties', name], says: say(note.says, { name }) }));
  },
  literal_could_bind: (note, workflow) => {
    const declared = new Set(Object.keys(workflow.input_schema?.properties ?? {}));
    return toolStepsOf(workflow).flatMap(step => Object.entries(object(step.input) ? step.input : {})
      .filter(([name, value]) => declared.has(name) && !isBinding(value))
      .map(([name]) => ({ at: ['steps', step.step_id, 'input', name], says: say(note.says, { step_id: step.step_id, tool_id: step.tool_id, name }) })));
  },
  tool_input_missing: (note, workflow, described) => toolStepsOf(workflow).flatMap(step => {
    const descriptor = described.get(step.tool_id);
    const given = new Set([...Object.keys(object(step.input) ? step.input : {}), ...Object.keys(object(descriptor?.fixed_input) ? descriptor.fixed_input : {})]);
    return (Array.isArray(descriptor?.input_schema?.required) ? descriptor.input_schema.required : []).filter(name => !given.has(name))
      .map(name => ({ at: ['steps', step.step_id, 'input', name], says: say(note.says, { step_id: step.step_id, tool_id: step.tool_id, name }) }));
  }),
};

/**
 * What a saved workflow could do better, from DATA notes. describe: (tool_id) → descriptor | null.
 * Returns [{ kind, at, says }].
 */
export async function authoringNotes(workflow, describe = null) {
  const described = new Map();
  if (describe) for (const step of toolStepsOf(workflow)) if (!described.has(step.tool_id)) described.set(step.tool_id, await describe(step.tool_id).catch(() => null));
  return guidance.notes.flatMap(note => (measures[note.kind] ? measures[note.kind](note, workflow, described) : []).map(found => ({ kind: note.kind, ...found })));
}
