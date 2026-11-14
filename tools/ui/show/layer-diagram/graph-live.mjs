// parts/ui/show/layer-diagram/graph-live.mjs
//
// A READER'S OWN AI STEERS AN OPEN GRAPH PICTURE THROUGH A FEW TYPED COMMANDS; THE APP ONLY CHECKS EVERY ID.
//
// Purpose: a person reading a graph can have their own AI explain it, point at parts of it, or sketch a change. The AI does the
// reading and the writing; this checks that every id it names is one the document holds, returns where those parts are drawn
// (the geometry atlas of ./graph-contract.mjs, so a surface rings them without measuring anything), and, for a sketch, applies
// the proposed operations to a COPY with ./graph-patch.mjs and returns that copy beside the original, which is never changed.
//
// Non-negotiable invariants:
//   1. The commands, their fields and every refusal's words are DATA (./graph-live.json); this file names no command.
//   2. Ids are the document's own, copied exactly: a lane or node by its id, an edge by `from>to`. An id the document does not
//      hold is refused (UNKNOWN_ID) with the path it was at, never dropped or guessed.
//   3. A command carries no position, size or style; where things are drawn is the atlas's answer.
//   4. An explicit `cannot_tell` is a first-class answer, not an error.
//   5. Nothing here changes the document in hand.
//
// Key concepts: `graphAddresses(document)`, `resolveLiveCommand(document, command)`.
import live from './graph-live.json' with { type: 'json' };
import contract from './graph-contract.json' with { type: 'json' };
import { renderGraphDocument, validateGraphDocument } from './graph-contract.mjs';
import { applyGraphOps } from './graph-patch.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));

/** Every id a command may name: lanes, nodes, and edges as `from>to`. -> Set */
export function graphAddresses(document, rules = live) {
  return new Set([
    ...document.lanes.flatMap((lane) => [lane.id, ...lane.nodes.map((node) => node.id)]),
    ...document.edges.map((edge) => `${edge.from}${rules.edge_separator}${edge.to}`),
  ]);
}

function check(spec, value, path, context, errors) {
  const refuse = (code, values = {}) => errors.push({ code, path, message: fill(context.rules.words.errors[code], { path, ...values }) });
  if (spec.type === 'flag') { if (typeof value !== 'boolean') refuse('WRONG_TYPE', { expected: 'true or false' }); return; }
  if (spec.type === 'text') {
    if (typeof value !== 'string' || !value.trim()) refuse('WRONG_TYPE', { expected: 'a non-empty string' });
    else if ([...value].length > spec.most) refuse('TOO_LONG', { most: `${spec.most} characters` });
    return;
  }
  if (!Array.isArray(value)) { refuse('WRONG_TYPE', { expected: 'a list' }); return; }
  if (spec.min && value.length < spec.min) refuse('TOO_FEW', { least: spec.min });
  if (spec.most && value.length > spec.most) { refuse('TOO_MANY', { most: spec.most }); return; }
  if (spec.type === 'ids') {
    value.forEach((id, index) => {
      if (typeof id !== 'string') errors.push({ code: 'WRONG_TYPE', path: `${path}[${index}]`, message: fill(context.rules.words.errors.WRONG_TYPE, { path: `${path}[${index}]`, expected: 'an id' }) });
      else if (!context.addresses.has(id)) errors.push({ code: 'UNKNOWN_ID', path: `${path}[${index}]`, message: fill(context.rules.words.errors.UNKNOWN_ID, { path: `${path}[${index}]`, found: id }) });
      else context.focus.add(id);
    });
    return;
  }
  if (spec.type === 'ops') { context.ops.push(...value); return; }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (spec.item.fields) checkObject(spec.item, item, itemPath, context, errors); else check(spec.item, item, itemPath, context, errors);
  });
}

function checkObject(shape, value, path, context, errors) {
  if (!isObject(value)) { errors.push({ code: 'NOT_AN_OBJECT', path, message: fill(context.rules.words.errors.NOT_AN_OBJECT, { path }) }); return; }
  for (const field of shape.required ?? []) {
    if (value[field] === undefined || value[field] === null) errors.push({ code: 'MISSING_FIELD', path: `${path}.${field}`, message: fill(context.rules.words.errors.MISSING_FIELD, { path: `${path}.${field}` }) });
  }
  for (const [field, inner] of Object.entries(value)) {
    if (!Object.hasOwn(shape.fields, field)) errors.push({ code: 'UNKNOWN_FIELD', path: `${path}.${field}`, message: fill(context.rules.words.errors.UNKNOWN_FIELD, { path: `${path}.${field}` }) });
    else check(shape.fields[field], inner, `${path}.${field}`, context, errors);
  }
}

/**
 * `command` ({ kind, ...fields }) checked against the document. -> { ok, errors, kind, focus: [id], boxes, sketch | null }
 * `boxes` are where the focused parts are drawn, in the atlas's own coordinates (both orientations); `sketch` is the document
 * the proposed operations give (a copy) for a sketch command.
 */
export function resolveLiveCommand(document, command, rules = live, contractRules = contract) {
  const refused = (errors, kind = null) => ({ ok: false, errors, kind, focus: [], boxes: null, sketch: null });
  const word = (code, path, values) => ({ code, path, message: fill(rules.words.errors[code], { path, ...values }) });
  if (!isObject(command)) return refused([word('NOT_AN_OBJECT', 'command')]);
  const { kind, ...fields } = command;
  if (typeof kind !== 'string' || !Object.hasOwn(rules.commands, kind)) return refused([word('UNKNOWN_COMMAND', 'command.kind', { found: String(kind), commands: Object.keys(rules.commands).join(', ') })]);
  if (!validateGraphDocument(document, contractRules).ok) return refused([word('NOT_AN_OBJECT', 'document')], kind);
  const context = { rules, addresses: graphAddresses(document, rules), focus: new Set(), ops: [] };
  const errors = [];
  checkObject(rules.commands[kind], fields, 'command', context, errors);
  if (errors.length) return refused(errors, kind);
  let sketch = null;
  if (context.ops.length) {
    const applied = applyGraphOps(document, context.ops, undefined, contractRules);
    if (!applied.ok) return refused(applied.errors.map((error) => ({ ...error, path: `command.${error.path}` })), kind);
    sketch = applied.document;
  }
  const atlas = renderGraphDocument(document, contractRules).atlas;
  const boxesOf = (way) => ({
    nodes: atlas[way].boxes.filter((box) => context.focus.has(box.id)),
    edges: atlas[way].edges.filter((edge) => context.focus.has(`${edge.from}${rules.edge_separator}${edge.to}`)),
  });
  return { ok: true, errors: [], kind, focus: [...context.focus], boxes: { across: boxesOf('across'), down: boxesOf('down') }, sketch };
}
