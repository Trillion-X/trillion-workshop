// src/made-controls.mjs
//
// PURPOSE
//   "Make me controls for this": an AI turns a person's intent ("a bit warmer", "reply to Ruth", "read my script") into
//   a small interface of live controls over one tool, saves it, and the person moves the controls themselves. Every
//   tool already says what it can take (input_schema); a tool may add `controls` DATA saying, in plain words, what a
//   person adjusts, what the preview shows and what keeping it does. This file turns those into control rows any screen
//   draws with the shared tuning panel, saves a made interface, and keeps each person's place in it.
//
//   A made interface is a workflow (src/workflows.mjs) the person owns: its one step runs the tool with the chosen
//   inputs, and its `screen` ({ kind: "controls", ... }) is the interface. So it reopens from its record with no AI,
//   is changed with make_controls on the same id, removed with remove_workflow, shared into a pursuit with
//   share_to_space (workflow:<id>) and published to the Marketplace as a template with publish_workflow, and other
//   AIs find it with find_workflow. What the person is working on (which video, the values they settled on, the full
//   copies they kept) is theirs alone: it is kept beside the workflow in their workspace records, never in the
//   workflow, so sharing or publishing the interface never carries their files.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a tool, an input or a kind of preview. Rows come from the tool's input_schema and its
//      `controls` DATA; a preview kind is a name the screen looks up.
//   2. Every control is an input of the tool, with the tool's own range: a value outside it is refused here, before a run.
//   3. An input that picks WHAT is changed (one of the person's files, a row, a place) is a subject, bound once and never
//      drawn as a control. A subject value never enters the workflow.
//   4. Saving the same interface id changes it; the person's place in it (values, kept copies) carries over.
//
// KEY CONCEPTS
//   controls DATA on a tool descriptor (all optional):
//     { about, subject: [input names], preview: { kind, input? , ... }, suggested: [input names],
//       settings: [{ input, label?, note?, widget?, min?, max?, step?, unit?, neutral?, options? }],
//       commit: { label, busy_label, done_label }, result: { file: "<output path to the kept file>" } }

import { failureOf } from './failure.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const withoutDefaults = value => Array.isArray(value) ? value.map(withoutDefaults) : object(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'default').map(([key, one]) => [key, withoutDefaults(one)])) : value;
const text = value => (typeof value === 'string' ? value.trim() : '');
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const words = key => key.replace(/[_-]+/g, ' ').replace(/^./, first => first.toUpperCase());
const typesOf = field => [field?.type].flat().filter(Boolean);
function schemaProblem(value, field) {
  if (!object(field)) return null;
  if (Array.isArray(field.anyOf)) {
    const problems = field.anyOf.map(option => schemaProblem(value, option));
    if (!problems.some(problem => problem === null)) return problems[0] ?? 'does not match the allowed values.';
    const { anyOf: _anyOf, ...common } = field;
    return schemaProblem(value, common);
  }
  if (Array.isArray(field.oneOf)) {
    const problems = field.oneOf.map(option => schemaProblem(value, option));
    const matches = problems.filter(problem => problem === null).length;
    if (matches !== 1) return 'does not match exactly one allowed value.';
    const { oneOf: _oneOf, ...common } = field;
    return schemaProblem(value, common);
  }
  if (Array.isArray(field.allOf)) {
    for (const option of field.allOf) {
      const problem = schemaProblem(value, option);
      if (problem) return problem;
    }
  }
  const types = typesOf(field);
  if (types.length) {
    const accepted = types.some(type => type === 'null' ? value === null
      : type === 'string' ? typeof value === 'string'
        : type === 'boolean' ? typeof value === 'boolean'
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : type === 'integer' ? Number.isInteger(value)
              : type === 'array' ? Array.isArray(value)
                : type === 'object' ? object(value) : false);
    if (!accepted) return types.includes('integer') ? 'must be a whole number.' : `must be ${types.join(' or ')}.`;
  }
  if (Array.isArray(field.enum) && !field.enum.some(one => JSON.stringify(one) === JSON.stringify(value))) return 'is not an available choice.';
  if (typeof value === 'number') {
    if (Number.isFinite(field.minimum) && value < field.minimum || Number.isFinite(field.maximum) && value > field.maximum) return `must be between ${field.minimum} and ${field.maximum}.`;
    if (Number.isFinite(field.exclusiveMinimum) && value <= field.exclusiveMinimum) return `must be greater than ${field.exclusiveMinimum}.`;
    if (Number.isFinite(field.exclusiveMaximum) && value >= field.exclusiveMaximum) return `must be less than ${field.exclusiveMaximum}.`;
    if (Number.isFinite(field.multipleOf) && value / field.multipleOf % 1 !== 0) return `must be a multiple of ${field.multipleOf}.`;
  }
  if (typeof value === 'string' && Number.isFinite(field.minLength) && value.length < field.minLength) return `must contain at least ${field.minLength} characters.`;
  if (typeof value === 'string' && Number.isFinite(field.maxLength) && value.length > field.maxLength) return `must contain at most ${field.maxLength} characters.`;
  if (Array.isArray(value)) {
    if (Number.isFinite(field.minItems) && value.length < field.minItems) return `must contain at least ${field.minItems} values.`;
    if (Number.isFinite(field.maxItems) && value.length > field.maxItems) return `must contain at most ${field.maxItems} values.`;
    for (const item of value) {
      const problem = schemaProblem(item, field.items);
      if (problem) return `contains a value that ${problem}`;
    }
  }
  if (object(value)) {
    for (const name of field.required ?? []) if (value[name] === undefined) return `must include ${name}.`;
    for (const [name, item] of Object.entries(value)) {
      if (!field.properties?.[name] && field.additionalProperties === false) return `does not accept ${name}.`;
      if (field.properties?.[name]) {
        const problem = schemaProblem(item, field.properties[name]);
        if (problem) return `${name} ${problem}`;
      }
    }
  }
  return null;
}
// Choice widgets submit strings. Preserve numeric enum types only when the submitted text is an exact
// representation of a declared numeric enum value; never accept arbitrary numeric-string coercion.
function typedEnumValue(value, field) {
  if (!object(field)) return value;
  if (typeof value === 'string' && Array.isArray(field.enum)) {
    return field.enum.find(option => typeof option === 'number' && String(option) === value) ?? value;
  }
  if (Array.isArray(value) && object(field.items)) return value.map(item => typedEnumValue(item, field.items));
  if (object(value) && object(field.properties)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typedEnumValue(item, field.properties[key] ?? {})]));
  }
  return value;
}
const STATE_PREFIX = 'controls-kept:';
const ID_PREFIX = 'workflow:controls-';
// How many controls an interface shows when nobody chose: few enough to understand at a glance.
const FEW = 5;
// The most interfaces one list answers.
const LISTED = 500;

/** An input that picks what is changed rather than how (invariant 3). */
function isSubject(name, field, declared) {
  if (declared.includes(name)) return true;
  return field?.format === 'namespace-file' || object(field?.['x-record']);
}

/** Required subjects come from the tool contract; optional record inputs stay optional. */
export function requiredControlSubjects(rows) {
  const required = new Set(rows.input_schema?.required ?? []);
  return rows.subject.filter(name => required.has(name));
}

/** One control row from one input schema property, or null when a person cannot set it by hand. */
function derivedRow(name, field) {
  const types = typesOf(field);
  const base = { key: name, label: text(field?.title) || words(name) };
  if ((types.includes('number') || types.includes('integer')) && Number.isFinite(field.minimum) && Number.isFinite(field.maximum)) {
    const span = field.maximum - field.minimum;
    const step = types.includes('integer') ? 1 : Math.pow(10, Math.floor(Math.log10(span / 100 || 1)));
    return { ...base, widget: 'slider', integer: types.includes('integer'), ...(Array.isArray(field.enum) ? { options: field.enum.map(value => ({ value: String(value), label: words(String(value)) })) } : {}), min: field.minimum, max: field.maximum, step, ...(field.default !== undefined ? { default_value: field.default } : {}) };
  }
  if (types.includes('number') || types.includes('integer')) return { ...base, widget: 'number', integer: types.includes('integer'), ...(Array.isArray(field.enum) ? { options: field.enum.map(value => ({ value: String(value), label: words(String(value)) })) } : {}), ...(Number.isFinite(field.minimum) ? { min: field.minimum } : {}), ...(Number.isFinite(field.maximum) ? { max: field.maximum } : {}) };
  if (types.includes('boolean')) return { ...base, widget: 'toggle', default_value: field.default ?? false };
  if (Array.isArray(field?.enum) && field.enum.length) return { ...base, widget: field.enum.length <= 6 ? 'choices' : 'select', options: field.enum.filter(value => value !== null).map(value => ({ value: String(value), label: words(String(value)) })) };
  if (types.includes('array') && Array.isArray(field?.items?.enum)) return {
    ...base,
    widget: 'many',
    options: field.items.enum.map(value => ({ value: String(value), label: words(String(value)) })),
    ...(Array.isArray(field.default) ? { default_value: field.default.map(value => String(value)) } : {}),
  };
  if (types.includes('string') || Array.isArray(field?.anyOf) && field.anyOf.some(one => typesOf(one).includes('string'))) return { ...base, widget: 'words' };
  return null;
}

/**
 * What a person can adjust on a tool: { subject, settings, preview, commit, result, about, suggested }. Settings are
 * tuning-panel rows (key, label, widget, min, max, step, options, default_value, note); `controls.settings` DATA adds a
 * row the schema does not hold (a screen's own input) or overrides a derived one field by field.
 */
export function controlRows(descriptor) {
  const controls = object(descriptor?.controls) ? descriptor.controls : {};
  const properties = object(descriptor?.input_schema?.properties) ? descriptor.input_schema.properties : {};
  const declaredSubject = Array.isArray(controls.subject) ? controls.subject.map(text).filter(Boolean) : [];
  for (const name of declaredSubject) if (!properties[name]) throw new Error(`${descriptor?.label ?? descriptor?.id ?? 'This tool'} declares "${name}" as a subject, but it is not in its input schema.`);
  const subject = Object.entries(properties).filter(([name, field]) => isSubject(name, field, declaredSubject)).map(([name]) => name);
  for (const name of declaredSubject) if (!subject.includes(name)) subject.push(name);
  const rows = new Map(Object.entries(properties).filter(([name]) => !subject.includes(name)).map(([name, field]) => [name, derivedRow(name, field)]).filter(([, row]) => row));
  for (const declared of Array.isArray(controls.settings) ? controls.settings : []) {
    const key = text(declared?.input);
    if (!key || subject.includes(key)) continue;
    if (!properties[key] && object(descriptor?.invoke)) throw new Error(`${descriptor?.label ?? descriptor?.id ?? 'This tool'} declares "${key}" as a control, but it is not in its input schema.`);
    const { input: _input, neutral, ...rest } = declared;
    const row = { ...(rows.get(key) ?? { key, label: words(key), widget: 'words' }), ...rest, key, ...(neutral !== undefined ? { default_value: neutral } : {}) };
    rows.set(key, row);
  }
  const settings = [...rows.values()];
  const suggested = (Array.isArray(controls.suggested) ? controls.suggested : []).filter(key => rows.has(key));
  return {
    tool_id: descriptor?.id ?? null,
    label: descriptor?.label ?? descriptor?.id ?? '',
    about: text(controls.about) || text(descriptor?.job),
    subject,
    settings,
    suggested: suggested.length ? suggested : settings.slice(0, FEW).map(row => row.key),
    preview: object(controls.preview) ? controls.preview : { kind: 'values' },
    commit: object(controls.commit) ? controls.commit : {},
    result: object(controls.result) ? controls.result : {},
    input_schema: object(descriptor?.input_schema) ? descriptor.input_schema : {},
    declared: Object.keys(controls).length > 0,
    // A tool that only opens a screen (no invoke) is never run: its interface opens the screen with the values.
    runs: object(descriptor?.invoke),
  };
}

// Semantic controls are account-authored DATA. One row may drive several ordinary tool inputs through
// formula-engine bindings; the underlying tool schema remains the final authority for every projected value.
const MAX_SEMANTIC_CONTROLS = 32;
const KEY = /^[a-z][a-z0-9_-]{0,47}$/;
function bindingProblem(binding, readableKeys) {
  if (!object(binding) || binding.$kind !== 'binding' || !object(binding.select) || binding.select.from !== 'self') return 'must be a formula binding that reads from its own input.';
  const path = binding.select.path;
  const parts = Array.isArray(path) ? path : typeof path === 'string' ? path.split('.') : null;
  if (!parts?.length || parts.some(part => typeof part !== 'string' || !part || part.length > 80)) return 'must name a readable input path.';
  if (!readableKeys.has(parts[0])) return `reads unknown input "${parts[0]}".`;
  const visited = new Set();
  const inspect = (value, depth = 0) => {
    if (depth > 16) return 'is nested too deeply.';
    if (value === null || typeof value !== 'object') return null;
    if (visited.has(value)) return 'contains a cycle.';
    visited.add(value);
    if (Array.isArray(value)) {
      if (value.length > 128) return 'contains too many values.';
      for (const one of value) { const issue = inspect(one, depth + 1); if (issue) return issue; }
    } else {
      if (value.$kind === 'binding') {
        const nestedPath = Array.isArray(value.select?.path) ? value.select.path : typeof value.select?.path === 'string' ? value.select.path.split('.') : null;
        if (value.select?.from !== 'self' || !nestedPath?.length || nestedPath.some(part => typeof part !== 'string' || !part) || !readableKeys.has(nestedPath[0])) return 'contains a nested formula that reads outside its declared inputs.';
      }
      for (const [key, one] of Object.entries(value)) if (key !== '$kind') { const issue = inspect(one, depth + 1); if (issue) return issue; }
    }
    visited.delete(value);
    return null;
  };
  const issue = inspect(binding, 0);
  if (issue) return issue;
  return JSON.stringify(binding).length > 16_384 ? 'is too large.' : null;
}
export function semanticControlRows(descriptor, definitions = descriptor?.controls?.semantic_controls ?? []) {
  if (!Array.isArray(definitions) || definitions.length > MAX_SEMANTIC_CONTROLS) throw new Error(`A control interface can have up to ${MAX_SEMANTIC_CONTROLS} semantic controls.`);
  const properties = object(descriptor?.input_schema?.properties) ? descriptor.input_schema.properties : {};
  const seen = new Set();
  const mappedInputs = new Set();
  const declaredSubjects = Array.isArray(descriptor?.controls?.subject) ? descriptor.controls.subject : [];
  const readableKeys = new Set([...Object.entries(properties).filter(([name, field]) => isSubject(name, field, declaredSubjects)).map(([name]) => name), ...declaredSubjects]);
  for (const definition of definitions) if (text(definition?.key)) readableKeys.add(text(definition.key));
  return definitions.map((definition, index) => {
    if (!object(definition) || !KEY.test(text(definition.key)) || seen.has(definition.key)) throw new Error(`Semantic control ${index + 1} needs a unique lowercase key.`);
    seen.add(definition.key);
    const key = definition.key;
    const label = text(definition.label);
    if (!label || label.length > 120) throw new Error(`Semantic control "${key}" needs a label of at most 120 characters.`);
    if (!object(definition.schema)) throw new Error(`Semantic control "${key}" needs a schema.`);
    if (Object.hasOwn(properties, key)) throw new Error(`Semantic control key "${key}" must not collide with a tool input.`);
    if (Object.keys(definition.schema).length > 32 || JSON.stringify(definition.schema).length > 16_384) throw new Error(`Semantic control "${key}" has an oversized schema.`);
    const base = derivedRow(key, { ...definition.schema, title: label });
    if (!base) throw new Error(`Semantic control "${key}" needs a supported value schema (text, number, choice, list of choices, or boolean).`);
    if (definition.note !== undefined && (typeof definition.note !== 'string' || definition.note.length > 240)) throw new Error(`Semantic control "${key}" note must be at most 240 characters.`);
    const bindings = definition.bindings;
    if (!object(bindings) || !Object.keys(bindings).length) throw new Error(`Semantic control "${key}" needs at least one tool input binding.`);
    if (Object.keys(bindings).length > 16 || JSON.stringify(bindings).length > 16_384) throw new Error(`Semantic control "${key}" has too many or too large input bindings.`);
    for (const [target, binding] of Object.entries(bindings)) {
      if (!Object.hasOwn(properties, target)) throw new Error(`Semantic control "${key}" maps to unknown tool input "${target}".`);
      if (isSubject(target, properties[target], Array.isArray(descriptor?.controls?.subject) ? descriptor.controls.subject : [])) throw new Error(`Semantic control "${key}" cannot map to subject input "${target}".`);
      if (mappedInputs.has(target)) throw new Error(`More than one semantic control maps to tool input "${target}".`);
      mappedInputs.add(target);
      const issue = bindingProblem(binding, readableKeys);
      if (issue) throw new Error(`Semantic control "${key}" binding for "${target}" ${issue}`);
    }
    // Strict decimal formula operators return decimal strings to preserve exact precision. A target
    // declared as a JSON number needs an explicit coercion through the shared fast numeric operator;
    // keeping it in the stored binding makes live projection and saved recipes use the same path.
    const projectedBindings = Object.fromEntries(Object.entries(bindings).map(([target, binding]) => {
      const field = properties[target];
      const numericTarget = typesOf(field).some(type => type === 'number' || type === 'integer');
      if (!numericTarget) return [target, structuredClone(binding)];
      if (Array.isArray(binding.transform) && binding.transform.at(-1)?.op === 'op:core.to_number') return [target, structuredClone(binding)];
      return [target, {
        ...structuredClone(binding),
        transform: [...(Array.isArray(binding.transform) ? structuredClone(binding.transform) : []), { op: 'op:core.to_number' }],
      }];
    }));
    return { ...base, ...(definition.note ? { note: text(definition.note) } : {}), schema: structuredClone(definition.schema), bindings: projectedBindings };
  });
}

/** Resolve semantic rows to ordinary, schema-checked tool inputs with the shared formula evaluator. */
export async function projectedInput(rows, bind = {}, values = {}, evaluateBinding) {
  const input = runInput(rows, bind, Object.fromEntries(Object.entries(values).filter(([key]) => rows.settings.some(row => row.key === key))));
  for (const row of rows.semantic_settings ?? []) {
    if (!Object.hasOwn(values, row.key)) continue;
    const checked = checkedValue(row, values[row.key]);
    if (checked instanceof Error) throw checked;
    const semantic = typedEnumValue(checked, row.schema);
    const problem = schemaProblem(semantic, row.schema);
    if (problem) throw new Error(`${row.label} ${problem}`);
    for (const [target, binding] of Object.entries(row.bindings)) {
      if (typeof evaluateBinding !== 'function') throw new Error('The shared formula evaluator is unavailable.');
      let value = await evaluateBinding(binding, { ...bind, ...values });
      // Formula engines may return a one-field result envelope; use its declared value just as list projections do.
      if (object(value) && Object.hasOwn(value, 'value') && Object.keys(value).length === 1) value = value.value;
      const field = rows.input_schema?.properties?.[target];
      const normalized = typedEnumValue(value, field);
      const issue = schemaProblem(normalized, field);
      if (issue) throw new Error(`${words(target)} ${issue}`);
      input[target] = normalized;
    }
  }
  return input;
}

/** Inputs supplied to a descriptor-owned composed screen, checked against that screen's own schema. */
export function projectViewInputs(views, bind = {}, values = {}, input = {}) {
  return (views ?? []).map(view => {
    const properties = view.input_schema?.properties ?? {};
    const projected = {};
    for (const [target, source] of Object.entries(view.inputs ?? {})) {
      const sourceMap = source.from === 'bind' ? bind : source.from === 'values' ? values : input;
      if (!Object.hasOwn(sourceMap, source.key)) continue;
      const value = typedEnumValue(sourceMap[source.key], properties[target]);
      const issue = schemaProblem(value, properties[target]);
      if (issue) throw new Error(`${view.label} ${words(target)} ${issue}`);
      projected[target] = value;
    }
    const missing_inputs = (view.input_schema?.required ?? []).filter(name => projected[name] === undefined);
    return { ...view, projected_input: projected, ...(missing_inputs.length ? { missing_inputs } : {}) };
  });
}

/** A value checked against its row (invariant 2): the value as the tool takes it, or an Error naming what is wrong. */
export function checkedValue(row, value) {
  if (value === undefined || value === null) return value;
  if (row.widget === 'slider' || row.widget === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(n)) return new Error(`${row.label} must be a number.`);
    if (row.integer && !Number.isInteger(n)) return new Error(`${row.label} must be a whole number.`);
    if (Number.isFinite(row.min) && n < row.min || Number.isFinite(row.max) && n > row.max) return new Error(`${row.label} must be between ${row.min} and ${row.max}.`);
    if (Array.isArray(row.options) && row.options.length && !row.options.some(option => option.value === String(n))) return new Error(`${row.label} is not an available choice.`);
    return n;
  }
  if (row.widget === 'toggle') return value === true || value === false ? value : new Error(`${row.label} must be on or off.`);
  if (row.widget === 'many') {
    if (!Array.isArray(value)) return new Error(`${row.label} is a list of choices.`);
    const allowed = Array.isArray(row.options) ? new Set(row.options.map(option => option.value)) : null;
    if (value.some(one => typeof one !== 'string' && typeof one !== 'number')) return new Error(`${row.label} contains a value that is not a choice.`);
    const values = value.map(String);
    return allowed && values.some(one => !allowed.has(one)) ? new Error(`${row.label} contains a choice that is not available.`) : values;
  }
  if (row.widget === 'shadow') {
    const keys = ['x', 'y', 'blur', 'spread', 'colour', 'opacity'];
    if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
      return new Error(`${row.label} must be a shadow with position, blur, spread, colour and opacity.`);
    }
    if (![value.x, value.y, value.blur, value.spread, value.opacity].every(Number.isFinite)
      || value.x < -200 || value.x > 200 || value.y < -200 || value.y > 200
      || value.blur < 0 || value.blur > 200 || value.spread < -100 || value.spread > 200
      || value.opacity < 0 || value.opacity > 1 || typeof value.colour !== 'string' || !value.colour.trim()) {
      return new Error(`${row.label} has a value outside the shadow controls.`);
    }
    return value;
  }
  if (row.widget === 'curve') {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
      return new Error(`${row.label} must have four finite timing-curve values.`);
    }
    const [x1, y1, x2, y2] = value;
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1 || y1 < -0.45 || y1 > 1.45 || y2 < -0.45 || y2 > 1.45) {
      return new Error(`${row.label} has a value outside the timing-curve controls.`);
    }
    return value;
  }
  if (Array.isArray(row.options) && row.options.length && ['choices', 'select'].includes(row.widget) && !row.options.some(option => option.value === String(value))) {
    return new Error(`${row.label} is one of: ${row.options.map(option => option.value).join(', ')}.`);
  }
  if (Array.isArray(row.options) && row.options.length && ['choices', 'select'].includes(row.widget)) return value;
  return typeof value === 'string' ? value : new Error(`${row.label} must be text.`);
}

/** The values a tool run takes from an interface: subject bindings and non-neutral controls. */
export function runInput(rows, bind = {}, values = {}) {
  const input = {};
  const required = new Set(rows.input_schema?.required ?? []);
  for (const name of rows.subject) if (bind[name] !== undefined && bind[name] !== '') {
    const field = rows.input_schema?.properties?.[name];
    const value = typedEnumValue(bind[name], field);
    const problem = schemaProblem(value, field);
    if (problem) throw new Error(`${words(name)} ${problem}`);
    input[name] = value;
  }
  for (const row of rows.settings) {
    const uiValue = checkedValue(row, values[row.key]);
    if (uiValue instanceof Error) throw uiValue;
    if (uiValue === undefined || (uiValue === null || uiValue === '') && !required.has(row.key)) continue;
    const field = rows.input_schema?.properties?.[row.key];
    const value = typedEnumValue(uiValue, field);
    const problem = schemaProblem(value, field);
    if (problem) throw new Error(`${row.label} ${problem}`);
    const neutral = row.default_value === undefined ? undefined : checkedValue(row, typedEnumValue(row.default_value, field));
    if (neutral instanceof Error) throw neutral;
    if (!required.has(row.key) && neutral !== undefined && JSON.stringify(uiValue) === JSON.stringify(neutral) && row.widget !== 'words') continue;
    input[row.key] = value;
  }
  return input;
}

/** A made interface's id: workflow:controls-<words>. */
export const interfaceId = (asked, intent) => {
  const given = text(asked);
  if (given.startsWith(ID_PREFIX)) return given;
  return `${ID_PREFIX}${slug(given || intent).slice(0, 48) || crypto.randomUUID().slice(0, 8)}`;
};

/**
 * The workflow that IS a made interface: one step running the tool with the interface's inputs, its `screen` the
 * controls (which, labelled how, starting where) and the intent it was made for. Subject values never enter it.
 */
export function interfaceRecipe({ id, intent, title, rows, settings, defaults = {}, layout = null, made_from = null, by = null, semantic_controls = [], views = [] }) {
  const chosen = settings.map(asked => (typeof asked === 'string' ? { input: asked } : asked)).map(one => {
    const row = [...rows.settings, ...(rows.semantic_settings ?? [])].find(item => item.key === text(one?.input));
    if (!row) throw new Error(`${rows.label} has no setting called "${text(one?.input)}". It has: ${rows.settings.map(item => item.key).join(', ')}.`);
    return { input: row.key, ...(row.schema ? { semantic: true } : {}), ...(text(one.label) ? { label: text(one.label) } : {}), ...(text(one.note) ? { note: text(one.note) } : {}) };
  });
  if (!chosen.length) throw new Error('Choose at least one setting to put on the interface.');
  const keep = {};
  for (const { input } of chosen) {
    const row = [...rows.settings, ...(rows.semantic_settings ?? [])].find(item => item.key === input);
    if (defaults[input] === undefined) continue;
    const field = row.schema ?? rows.input_schema?.properties?.[input];
    const value = checkedValue(row, typedEnumValue(defaults[input], field));
    if (value instanceof Error) throw value;
    const problem = schemaProblem(typedEnumValue(value, field), field);
    if (problem) throw new Error(`${row.label} ${problem}`);
    keep[input] = value;
  }
  const subjectSchema = Object.fromEntries(rows.subject.map(name => [name, rows.input_schema?.properties?.[name] ?? { type: 'string', description: `What this interface works on (${words(name).toLowerCase()})` }]));
  const allSettings = [...rows.settings, ...(rows.semantic_settings ?? [])];
  const settingSchema = Object.fromEntries(chosen.map(({ input }) => {
    const schema = allSettings.find(row => row.key === input)?.schema ?? rows.input_schema?.properties?.[input] ?? {};
    return [input, withoutDefaults(schema)];
  }));
  const toolInputs = {};
  const requiredSubjects = new Set(requiredControlSubjects(rows));
  for (const name of rows.subject) toolInputs[name] = { from: ['input', name], ...(!requiredSubjects.has(name) ? { omit_if_missing: true } : {}) };
  const projectionSteps = [];
  let projectionIndex = 0;
  for (const { input: key } of chosen) {
    const row = allSettings.find(item => item.key === key);
    if (row?.schema) {
      for (const [target, binding] of Object.entries(row.bindings)) {
        if (Object.hasOwn(toolInputs, target)) throw new Error(`More than one interface input maps to tool input "${target}".`);
        const stepId = `project-${projectionIndex++}`;
        projectionSteps.push({
          id: stepId,
          title: `Prepare ${row.label}`,
          do: `Calculate the ${target} input from the interface values.`,
          submit: { type: 'object', required: ['value'], properties: { value: {} } },
          run_tool: { tool_id: 'tool:evaluate-binding', input: {
            binding: { $kind: 'opaque-json', value: binding },
            input: { from: ['input'] },
          } },
        });
        toolInputs[target] = { from: ['steps', stepId, 'value'] };
      }
    } else {
      if (Object.hasOwn(toolInputs, key)) throw new Error(`More than one interface input maps to tool input "${key}".`);
      toolInputs[key] = { from: ['input', key] };
    }
  }
  const required = requiredControlSubjects(rows);
  for (const { input: key } of chosen) {
    const row = allSettings.find(item => item.key === key);
    if (row?.schema && Object.keys(row.bindings).some(target => (rows.input_schema?.required ?? []).includes(target))) required.push(key);
  }
  return {
    id,
    label: title,
    job: intent,
    input_schema: { type: 'object', properties: { ...subjectSchema, ...settingSchema }, ...(required.length ? { required: [...new Set(required)] } : {}) },
    steps: rows.runs ? [...projectionSteps, {
      id: 'run',
      title: rows.label,
      do: `Run ${rows.tool_id} with the values set on this interface.`,
      submit: { type: 'object' },
      run_tool: { tool_id: rows.tool_id, input: toolInputs },
    }] : [{
      id: 'open',
      title: rows.label,
      do: `Open ${rows.label} with the values set on this interface (make_controls opened it as /controls/${id}).`,
      submit: { type: 'object' },
    }],
    screen: {
      kind: 'controls',
      tool_id: rows.tool_id,
      intent,
      settings: chosen,
      defaults: keep,
      ...(semantic_controls.length ? { semantic_controls: semantic_controls.map(one => ({ ...structuredClone(one), schema: withoutDefaults(one.schema) })) } : {}),
      ...(views.length ? { views: structuredClone(views) } : {}),
      ...(layout ? { layout } : {}),
      ...(by ? { by } : {}),
    },
    ...(made_from ? { made_from } : {}),
  };
}

/** The interface a saved workflow holds, or null when it is not one. */
export function interfaceOf(workflow) {
  return object(workflow?.screen) && workflow.screen.kind === 'controls' && text(workflow.screen.tool_id) ? workflow.screen : null;
}

/** The rows the interface shows, in its order, with its own words over the tool's. */
export function shownRows(rows, screen) {
  return screen.settings.map(one => {
    const row = [...rows.settings, ...(rows.semantic_settings ?? [])].find(item => item.key === one.input);
    if (!row) return null;
    return { ...row, ...(one.label ? { label: one.label } : {}), ...(one.note ? { note: one.note } : {}) };
  }).filter(Boolean);
}

/**
 * The owner over the person's tools, workflows, tours and workspace records:
 *   describeTool(tool_id) → descriptor          findTool(job) → candidates
 *   saveWorkflow(workflow) → saved              describeWorkflow(id) → { workflow, made_by }
 *   listScreens({ kind, limit }) → { workflows: [{ workflow_id, label, screen }] }   this account's own saved screens
 *   saveTour(input) → saved                     records: { read(scope), write(writes) }
 */
// The writes whose whole effect is one synchronous write, committed with their answer through `commit` (a write and its
// answer kept under the command's receipt, src/standalone-resource-behavior.mjs routeReceipts).
export const CONTROLS_RECEIPTED_WRITES = Object.freeze(['controls:keep', 'controls:make']);
export function makeMadeControls({ describeTool, findTool, saveWorkflow, describeWorkflow, listScreens, saveTour, records, runTool, readTask, evaluateBinding, now = () => new Date(), commit = change => change(), begin = () => {} }) {
  const stateLabel = id => `${STATE_PREFIX}${id}`;
  const readState = id => {
    const current = records.read({ labels: [stateLabel(id)] }) ?? {};
    return object(current[stateLabel(id)]) ? current[stateLabel(id)] : { bind: {}, values: {}, kept: [] };
  };
  const writeState = (id, state) => records.write([{ address_label: stateLabel(id), payload: { ...state, at: now().toISOString() } }]);

  async function current(id) {
    const { workflow, made_by } = await describeWorkflow(id);
    const screen = interfaceOf(workflow);
    if (!screen) throw new Error(`${id} is not an interface of controls.`);
    const { descriptor } = await describeTool(screen.tool_id);
    const rows = controlRows(descriptor);
    rows.semantic_settings = semanticControlRows(descriptor, screen.semantic_controls ?? descriptor?.controls?.semantic_controls ?? []);
    const views = await resolveViews(screen.views ?? [], rows, screen.settings);
    rows.views = views;
    return { workflow, screen, descriptor, rows, shown: shownRows(rows, screen), made_by };
  }

  async function resolveViews(definitions, rows, selectedSettings = []) {
    if (!Array.isArray(definitions) || definitions.length > 16) throw new Error('An interface can have up to 16 composed views.');
    const seen = new Set();
    const resolved = [];
    for (const [index, definition] of definitions.entries()) {
      if (!object(definition) || !KEY.test(text(definition.id)) || seen.has(definition.id)) throw new Error(`Composed view ${index + 1} needs a unique lowercase id.`);
      seen.add(definition.id);
      const toolId = text(definition.tool_id);
      if (!toolId.startsWith('tool:')) throw new Error(`Composed view "${definition.id}" needs a registered tool_id.`);
      const described = await describeTool(toolId);
      const descriptor = described?.descriptor;
      if (!descriptor) throw new Error(`Composed view "${definition.id}" must name a registered tool.`);
      if (!object(definition.inputs)) throw new Error(`Composed view "${definition.id}" needs an input mapping.`);
      const targetProperties = descriptor.input_schema?.properties ?? {};
      const selected = new Set(selectedSettings.map(row => row.input));
      const sourceNames = new Set([...rows.subject, ...rows.settings.filter(row => selected.has(row.key)).map(row => row.key), ...rows.semantic_settings.filter(row => selected.has(row.key)).map(row => row.key)]);
      for (const row of rows.semantic_settings.filter(one => selected.has(one.key))) for (const target of Object.keys(row.bindings)) sourceNames.add(target);
      for (const [target, source] of Object.entries(definition.inputs)) {
        if (!Object.hasOwn(targetProperties, target)) throw new Error(`Composed view "${definition.id}" maps unknown input "${target}".`);
        if (!object(source) || !['bind', 'values', 'input'].includes(source.from) || !KEY.test(text(source.key))) throw new Error(`Composed view "${definition.id}" has an invalid input mapping for "${target}".`);
        if (source.from === 'bind' && !rows.subject.includes(source.key)) throw new Error(`Composed view "${definition.id}" maps from unknown bound subject "${source.key}".`);
        if (source.from === 'values' && !sourceNames.has(source.key)) throw new Error(`Composed view "${definition.id}" maps from unknown control value "${source.key}".`);
        if (source.from === 'input' && !sourceNames.has(source.key)) throw new Error(`Composed view "${definition.id}" maps from unavailable input "${source.key}".`);
      }
      for (const name of descriptor.input_schema?.required ?? []) if (!Object.hasOwn(definition.inputs, name)) throw new Error(`Composed view "${definition.id}" needs a mapping for required input "${name}".`);
      resolved.push({ id: definition.id, tool_id: toolId, label: descriptor.label ?? toolId,
        preview: { kind: 'screen', entry: 'tool-screen', input: { tool_id: toolId } },
        ...(descriptor.screen ? { screen: descriptor.screen } : {}),
        input_schema: descriptor.input_schema ?? { type: 'object', properties: {} }, inputs: structuredClone(definition.inputs) });
    }
    return resolved;
  }

  function schemaValue(name, value, schema) {
    const field = schema?.properties?.[name];
    if (!field) throw new Error(`This interface does not accept "${name}".`);
    value = typedEnumValue(value, field);
    const problem = schemaProblem(value, field);
    if (problem) throw new Error(`${words(name)} ${problem}`);
    return value;
  }

  function validatePlace(place, input) {
    if (!object(input)) throw new Error('Send the control values as an object.');
    if (input.bind !== undefined && !object(input.bind)) throw new Error('Send bound subjects as an object.');
    if (input.values !== undefined && !object(input.values)) throw new Error('Send control values as an object.');
    const properties = place.descriptor.input_schema?.properties ?? {};
    const bind = object(input.bind) ? input.bind : {};
    for (const name of Object.keys(bind)) if (!place.rows.subject.includes(name)) throw new Error(`This interface does not accept "${name}" as the thing to work on.`);
    const checkedBind = Object.fromEntries(Object.entries(bind).map(([name, value]) => [name, schemaValue(name, value, { properties })]));
    const values = object(input.values) ? input.values : {};
    const selected = new Set(place.shown.map(row => row.key));
    for (const name of Object.keys(values)) if (!selected.has(name)) throw new Error(`This interface does not accept a value for "${name}".`);
    const checkedValues = {};
    for (const [name, submittedValue] of Object.entries(values)) {
      const row = place.shown.find(one => one.key === name);
      const valueSchema = row.schema ?? properties[name];
      const normalized = valueSchema ? typedEnumValue(submittedValue, valueSchema) : submittedValue;
      const problem = valueSchema ? schemaProblem(normalized, valueSchema) : null;
      if (problem) throw new Error(`${row.label} ${problem}`);
      const checked = checkedValue(row, normalized);
      if (checked instanceof Error) throw checked;
      // Multi-choice widgets keep their string option ids in the interface
      // state; runInput converts enum items to the tool's declared types.
      checkedValues[name] = checked;
    }
    return { bind: checkedBind, values: checkedValues };
  }

  const terminal = state => ['completed', 'failed', 'refused', 'cancelled'].includes(state);
  function declaredFile(output, path) {
    if (typeof path !== 'string' || !path.trim()) return undefined;
    const segments = path.replace(/^\$\.?/, '').replace(/\[(?:"|')?([^\]"']+)(?:"|')?\]/g, '.$1').split('.').filter(Boolean);
    let value = output;
    for (const segment of segments) value = value?.[segment];
    return value;
  }

  async function reconcile(id, state, immediate = null) {
    let pending = state.pending;
    if (!object(pending) || pending.terminal === true) return state;
    let task = immediate;
    if (!task && !pending.task_id && object(pending.input) && typeof runTool === 'function') {
      try {
        task = await runTool({
          tool_id: pending.tool_id,
          input: pending.input,
          request_key: pending.workshop_request_key,
          wait_seconds: 30,
        });
        if (task?.task_id) {
          state = { ...state, pending: { ...pending, task_id: task.task_id, state: task.state ?? 'starting' } };
          pending = state.pending;
          writeState(id, state);
        }
      } catch (error) {
        return { ...state, last_error: String(error?.message ?? error) };
      }
    }
    if (pending.task_id && typeof readTask === 'function') {
      try { task = await readTask(pending.task_id) ?? task; }
      catch (error) {
        return { ...state, last_error: String(error?.message ?? error) };
      }
    }
    if (!task) return state;
    if (pending.task_id && task.task_id && pending.task_id !== task.task_id ||
        pending.tool_id && task.tool_id && pending.tool_id !== task.tool_id ||
        pending.workshop_request_key && task.request_key && pending.workshop_request_key !== task.request_key) {
      const error = 'The Workshop task did not match this interface run.';
      const next = { ...state, last_error: error, pending: { ...pending, state: 'failed', terminal: true, error } };
      writeState(id, next);
      return next;
    }
    const next = { ...state, pending: { ...pending, ...(task.task_id ? { task_id: task.task_id } : {}), state: task.state ?? pending.state } };
    if (task.state === 'failed' || task.state === 'refused' || task.state === 'cancelled') {
      next.last_error = String(task.error ?? task.message ?? `The run ${task.state}.`);
      next.pending = { ...next.pending, terminal: true, error: next.last_error };
      writeState(id, next);
      return next;
    }
    if (task.state === 'completed') {
      const rawOutput = task.output;
      const filePath = pending.result?.file;
      if (filePath) {
        const file = declaredFile(rawOutput, filePath);
        if (!pending.task_id || task.task_id !== pending.task_id) {
          next.last_error = 'The completed file could not be tied to this Workshop task.';
        } else if (object(file) && typeof file.identity === 'string' && typeof file.name === 'string') {
          next.kept = [{ ...file, task_id: pending.task_id, request_key: pending.request_key, values: pending.values }, ...(next.kept ?? []).filter(one => one.request_key !== pending.request_key)].slice(0, 20);
          delete next.last_error;
        } else {
          next.last_error = `The run finished, but its declared result file (${filePath}) was not present.`;
        }
      } else {
        if (pending.task_id && task.task_id === pending.task_id) {
          next.kept = [{ task_id: pending.task_id, request_key: pending.request_key, values: pending.values, at: now().toISOString() }, ...(next.kept ?? []).filter(one => one.request_key !== pending.request_key)].slice(0, 20);
          delete next.last_error;
        } else {
          next.last_error = 'The completed run could not be tied to this Workshop task.';
        }
      }
      next.pending = { ...next.pending, state: 'completed', terminal: true, ...(next.last_error ? { error: next.last_error } : {}) };
      writeState(id, next);
      return next;
    }
    writeState(id, next);
    return next;
  }

  async function toolFor(input) {
    const named = text(input.tool_id);
    if (named) return (await describeTool(named)).descriptor;
    const job = text(input.job) || text(input.intent);
    if (!job) throw new Error('Say what to make controls for: tool_id, or job (what the tool does) with intent.');
    const { candidates = [] } = await findTool(job);
    // The best match that has something a person can set by hand.
    for (const candidate of candidates) {
      const { descriptor } = await describeTool(candidate.tool_id);
      if (controlRows(descriptor).settings.length) return descriptor;
    }
    throw new Error(`No tool found for "${job}" has settings a person can adjust. find_tool_for_job lists what there is.`);
  }

  // The tour that shows the interface working: each control moved on the real screen, once, then handed over.
  function demoTour(id, title, rows, shown, defaults) {
    const surface = { surface: { id: 'trillion.controls', surface_input: { id }, title } };
    const moves = shown.filter(row => row.widget === 'slider').slice(0, 2).map(row => {
      const from = Number(defaults[row.key] ?? row.default_value ?? row.min);
      const span = row.max - row.min;
      const to = Math.round(Math.min(row.max, Math.max(row.min, from + span * (from > (row.min + row.max) / 2 ? -0.25 : 0.25))) / row.step) * row.step;
      return {
        id: `move-${row.key}`,
        content: { content_kind: 'text', payload: { title: `${row.label}`, body: `Watch the picture as ${row.label.toLowerCase()} moves.` } },
        target_ref: { from: 'selector', query: `[data-tuning-setting="${row.key}"] input[type="range"]` },
        target_preparation: surface,
        act: { do: 'slide', text: String(Number(to.toFixed(4))), every_ms: 60 },
        look: { hold_ms: 2600 },
      };
    });
    if (!moves.length) return null;
    return {
      id: `controls-demo-${id.slice(ID_PREFIX.length)}`,
      title: `Try ${title}`,
      summary: 'Each control changes the preview at once.',
      play: { step_ms: 2600, after_ms: 1400 },
      steps: [...moves, {
        id: 'your-turn',
        content: { content_kind: 'text', payload: { title: 'Your turn', body: 'Move them yourself until it looks right, then keep a full copy.' } },
        target_ref: { from: 'selector', query: '[data-controls-keep]' },
        target_preparation: surface,
      }],
    };
  }

  async function make(input = {}) {
    const intent = text(input.intent);
    if (!intent) throw new Error('intent: what the person wants to adjust, in their words ("a bit warmer", "reply to Ruth").');
    if (input.layout !== undefined && !['beside', 'above'].includes(input.layout)) throw new Error('Choose Beside or Above for the preview position.');
    const descriptor = await toolFor(input);
    const rows = controlRows(descriptor);
    const earlierWorkflow = input.id ? (await describeWorkflow(interfaceId(input.id, intent)).catch(() => ({}))).workflow : null;
    const earlierScreen = interfaceOf(earlierWorkflow);
    const semanticDefinitions = input.semantic_controls ?? earlierScreen?.semantic_controls ?? descriptor?.controls?.semantic_controls ?? [];
    rows.semantic_settings = semanticControlRows(descriptor, semanticDefinitions);
    const id = interfaceId(input.id, intent);
    let earlier = null;
    try { earlier = interfaceOf((await describeWorkflow(id)).workflow); } catch { earlier = null; }
    const semanticTargets = new Set(rows.semantic_settings.flatMap(row => Object.keys(row.bindings)));
    const fallbackSettings = [...rows.suggested.filter(key => !semanticTargets.has(key)), ...rows.semantic_settings.slice(0, FEW).map(row => row.key)];
    const settings = Array.isArray(input.settings) && input.settings.length ? input.settings : earlier?.settings ?? fallbackSettings;
    const title = text(input.title) || intent.charAt(0).toUpperCase() + intent.slice(1);
    // Share only neutral values declared by the tool. The person's baseline and starting values, which can contain
    // private draft text, live beside the workflow in workspace state.
    const chosenKeys = new Set((Array.isArray(settings) ? settings : []).map(one => text(typeof one === 'string' ? one : one?.input)));
    const allRows = [...rows.settings, ...rows.semantic_settings];
    const genericDefaults = Object.fromEntries(allRows
      .filter(row => !row.schema)
      .filter(row => chosenKeys.has(row.key) && row.default_value !== undefined && !(checkedValue(row, row.default_value) instanceof Error))
      .map(row => [row.key, row.default_value]));
    const views = input.views ?? earlier?.views ?? [];
    const recipe = interfaceRecipe({ id, intent, title, rows, settings, defaults: genericDefaults, layout: text(input.layout) || null, by: text(input.by) || null, made_from: Array.isArray(input.made_from) ? input.made_from : null, semantic_controls: semanticDefinitions, views });
    const bind = object(input.bind) ? input.bind : {};
    const shown = shownRows(rows, recipe.screen);
    const resolvedViews = await resolveViews(views, rows, recipe.screen.settings);
    const initial = validatePlace({ descriptor, rows, shown }, { bind, values: object(input.values) ? input.values : {} });
    const selected = new Set(shown.map(row => row.key));
    const state = readState(id);
    const combinedBind = { ...state.bind, ...initial.bind };
    const currentValues = Object.fromEntries(Object.entries(state.values ?? {}).filter(([name]) => selected.has(name)));
    const validatedState = validatePlace({ descriptor, rows, shown }, { bind: combinedBind, values: { ...currentValues, ...initial.values } });
    const privateDefaults = Object.fromEntries(Object.entries({ ...recipe.screen.defaults, ...(earlier?.defaults ?? {}), ...(state.defaults ?? {}), ...initial.values }).filter(([name]) => selected.has(name)));
    // Its writes span awaits: begun before the first, its answer committed as the last step (CONTROLS_RECEIPTED_WRITES).
    begin({ operation: 'controls:make' });
    const saved = await saveWorkflow(recipe);
    writeState(id, { ...state, bind: validatedState.bind, defaults: privateDefaults, values: validatedState.values });
    const missing = requiredControlSubjects(rows).filter(name => validatedState.bind[name] === undefined || validatedState.bind[name] === '');
    let tour = null;
    if (input.demo !== false) {
      const definition = demoTour(id, title, rows, shown, recipe.screen.defaults);
      if (definition) tour = (await saveTour({ tour: definition, category: 'Controls', show_now: input.open_now !== false, by: text(input.by) || null }).catch(error => ({ error: error.message }))) ?? null;
    }
    const open_path = `/controls/${encodeURIComponent(id)}`;
    const answer = {
      interface_id: id,
      workflow_id: id,
      title,
      tool_id: rows.tool_id,
      controls: shown.map(row => ({ input: row.key, label: row.label, widget: row.widget, ...(row.min !== undefined ? { min: row.min, max: row.max } : {}) })),
      views: resolvedViews,
      bound: Object.keys({ ...state.bind, ...bind }),
      ...(missing.length ? { still_to_choose: missing, note: `The person chooses ${missing.join(', ')} on the interface, or send bind.` } : {}),
      replaced: Boolean(earlier),
      tour: tour?.tour ? { tour_id: tour.tour.tour_id, plays: input.open_now !== false } : tour?.error ? { not_saved: tour.error } : null,
      open_path,
      ...(input.open_now !== false ? { 'trillion/screen': { id: 'trillion.controls', label: title, input: { id }, address: open_path, presentation: 'focused' } } : {}),
      said: `${earlier ? 'Changed' : 'Made'} ${title}: ${shown.map(row => row.label).join(', ')}. It opens from its record every time, with no AI.`,
      next_calls: {
        change: { tool: 'make_controls', arguments: { id, intent, settings: '(the inputs to show)' } },
        share_into_a_pursuit: { tool: 'share_to_space', arguments: { space_id: '(a pursuit)', record: `workflow:${id.slice('workflow:'.length)}` } },
        publish_as_template: { tool: 'publish_workflow', arguments: { workflow_id: id } },
        remove: { tool: 'remove_workflow', arguments: { workflow_id: id } },
      },
      ...(saved?.similar_workflows ? { similar_workflows: saved.similar_workflows } : {}),
    };
    return commit(() => answer, { operation: 'controls:make' });
  }

  // Everything the screen needs to draw an interface, read from its records: no AI and no generation.
  async function read(input = {}, { reconcileRun = true } = {}) {
    const id = text(input.id);
    if (!id) throw new Error('Say which interface with id.');
    const place = await current(id);
    const { workflow, screen, descriptor, rows, shown, made_by } = place;
    const state = reconcileRun ? await reconcile(id, readState(id)) : readState(id);
    const mainInput = await projectedInput(rows, state.bind, state.values, evaluateBinding);
    const views = projectViewInputs(rows.views, state.bind, state.values, mainInput);
    return {
      interface_id: id, title: workflow.label ?? screen.intent, intent: screen.intent, made_by: made_by ?? null,
      tool: { id: descriptor.id, label: descriptor.label ?? descriptor.id, input_schema: descriptor.input_schema ?? null, screen: descriptor.screen ?? null },
      input_schema: rows.input_schema,
      subject: rows.subject, rows: shown, all_rows: [...rows.settings, ...rows.semantic_settings], semantic_settings: rows.semantic_settings, views,
      projected_input: mainInput,
      defaults: state.defaults ?? screen.defaults ?? {},
      preview: rows.preview, commit: rows.commit, result: rows.result, runs: rows.runs, layout: screen.layout ?? null,
      state,
    };
  }

  // Keep only values and bindings that this saved interface currently allows; result rows are server-owned.
  async function keep(input = {}) {
    const id = text(input.id);
    if (!id) throw new Error('Say which interface with id.');
    const place = await current(id);
    const state = readState(id);
    const checked = validatePlace(place, input);
    if (Object.keys(input).some(key => !['id', 'bind', 'values'].includes(key))) throw new Error('Only this interface, its bound subject and its control values can be kept.');
    const nextBind = { ...state.bind, ...checked.bind };
    const nextValues = { ...state.values };
    for (const [name, value] of Object.entries(checked.values)) nextValues[name] = value;
    const selected = new Set(place.shown.map(row => row.key));
    for (const name of Object.keys(nextValues)) if (!selected.has(name)) delete nextValues[name];
    const validated = validatePlace(place, { bind: nextBind, values: nextValues });
    const next = {
      ...state, bind: validated.bind, values: validated.values, kept: state.kept ?? [],
    };
    return commit(() => {
      writeState(id, next);
      return { interface_id: id, state: next };
    }, { operation: 'controls:keep' });
  }

  async function run(input = {}) {
    const id = text(input.id);
    const requestKey = typeof input.request_key === 'string' ? input.request_key : '';
    if (!id) throw new Error('Say which interface with id.');
    if (!requestKey || requestKey !== requestKey.trim() || requestKey.length > 200) throw new Error('Send a request_key of at most 200 characters without leading or trailing spaces.');
    const place = await current(id);
    if (!place.rows.runs) throw new Error('This interface opens a screen and does not run a tool.');
    if (Object.keys(input).some(key => !['id', 'values', 'request_key'].includes(key))) throw new Error('Only this interface, its control values and request_key can be run.');
    if (input.values !== undefined && !object(input.values)) throw new Error('Send control values as an object.');
    const state = readState(id);
    if (typeof runTool !== 'function') throw new Error('The Workshop run owner is unavailable.');
    let retryPending = null;
    if (object(state.pending) && terminal(state.pending.state) && state.pending.request_key === requestKey) {
      const submitted = input.values ?? {};
      if (JSON.stringify(state.pending.submitted_values ?? state.pending.values ?? {}) !== JSON.stringify(submitted)) throw new Error('This request_key already names a different set of control values.');
      return read({ id });
    }
    if (object(state.pending) && !terminal(state.pending.state)) {
      if (state.pending.request_key !== requestKey) throw new Error('This interface already has a run in progress.');
      const submitted = object(input.values) ? input.values : {};
      if (JSON.stringify(state.pending.submitted_values ?? state.pending.values ?? {}) !== JSON.stringify(submitted)) throw new Error('This request_key already names a different set of control values.');
      if (state.pending.task_id) return read({ id });
      retryPending = state.pending;
    }
    let pending = retryPending;
    if (!retryPending) {
      const posted = validatePlace(place, { bind: state.bind, values: input.values ?? {} });
      const values = { ...state.values, ...posted.values };
      for (const name of Object.keys(values)) if (!place.shown.some(row => row.key === name)) delete values[name];
      const validated = validatePlace(place, { bind: state.bind, values });
      Object.assign(values, validated.values);
      const merged = await projectedInput(place.rows, state.bind, values, evaluateBinding);
      const required = place.descriptor.input_schema?.required ?? [];
      for (const name of required) if (merged[name] === undefined && values[name] !== undefined) {
        const row = place.rows.settings.find(one => one.key === name);
        if (row) {
          const checked = checkedValue(row, values[name]);
          if (checked instanceof Error) throw checked;
          merged[name] = checked;
        }
      }
      const missing = required.filter(name => merged[name] === undefined);
      if (missing.length) throw new Error(`Choose ${missing.join(', ')} before running this interface.`);
      const workshopRequestKey = `controls:${id}:${requestKey}`;
      pending = { task_id: null, request_key: requestKey, workshop_request_key: workshopRequestKey, values: { ...values }, submitted_values: structuredClone(object(input.values) ? input.values : {}), input: merged, tool_id: place.descriptor.id, result: structuredClone(place.rows.result), state: 'starting' };
      const starting = { ...state, values: { ...state.values, ...posted.values }, pending };
      delete starting.last_error;
      writeState(id, starting);
    }
    const starting = readState(id);
    delete starting.last_error;
    writeState(id, starting);
    try {
      const result = await runTool({
        tool_id: pending.tool_id ?? place.descriptor.id,
        input: pending.input,
        request_key: pending.workshop_request_key ?? `controls:${id}:${requestKey}`,
        wait_seconds: 30,
      });
      const withTask = { ...starting, pending: { ...pending, ...(result?.task_id ? { task_id: result.task_id } : {}), state: result?.state ?? 'starting' } };
      writeState(id, withTask);
      await reconcile(id, withTask, result);
      return read({ id });
    } catch (error) {
      const currentState = readState(id);
      const next = { ...currentState, last_error: String(error?.message ?? error) };
      writeState(id, next);
      return read({ id });
    }
  }

  // A lost run read from the interface's kept run, never by running again: a run kept under this request_key is that
  // run, answered with the interface as it is now (read without reconciling); none, or another key's run, cannot say
  // whether it started before a later run replaced it.
  async function runOutcome(input = {}) {
    const id = text(input.id);
    if (!id || typeof input.request_key !== 'string' || !input.request_key) return { state: 'aborted' };
    return readState(id).pending?.request_key === input.request_key ? { state: 'committed', result: await read({ id }, { reconcileRun: false }) } : { state: 'unknown' };
  }

  // Every interface this person made: its id, name, the words it was made for and its tool, so the words typed again
  // find it (src/instant-screens.mjs). It reads the person's own saved workflows only and runs nothing.
  async function list({ limit = LISTED } = {}) {
    const { workflows } = await listScreens({ kind: 'controls', limit: Math.min(Math.max(Math.trunc(Number(limit)) || 1, 1), LISTED) });
    return { interfaces: workflows.map(({ workflow_id, label, screen }) => ({ interface_id: workflow_id, title: label, intent: text(screen?.intent), tool_id: text(screen?.tool_id) })) };
  }

  return { make, read, inspect: input => read(input, { reconcileRun: false }), keep, run, runOutcome, list };
}

const PATHS = { '/controls/make': 'make', '/controls/read': 'read', '/controls/inspect': 'inspect', '/controls/keep': 'keep', '/controls/run': 'run', '/controls/list': 'list' };
/** The account's /controls routes over `controls` (makeMadeControls), answered in its own records resource
 * (src/native-owner-routes.json). */
export async function handleControlsRequest(controls, request) {
  const verb = PATHS[new URL(request.url).pathname];
  if (!verb || request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    return Response.json(await controls[verb](await request.json().catch(() => ({}))));
  } catch (error) {
    const failure = failureOf(error);
    // Every failure that tries again later (busy, interrupted, exhausted, a reached use budget) reaches the shared
    // failure owner, which answers it with its retry policy; only a refusal of this request is answered here.
    if (failure.tries_again_later) throw error;
    return Response.json({
      error: error.message,
      ...(failure.code === 'unexpected' ? {} : { failure_code: failure.code }),
      ...(failure.retry_at ? { retry_at: failure.retry_at } : {}),
      ...(failure.retry_after_seconds !== null ? { retry_after_seconds: failure.retry_after_seconds } : {}),
    }, { status: Number.isInteger(error.status) ? error.status : 400 });
  }
}

// Required current native-owner API; existing owner behavior is retained.
