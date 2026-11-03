// tools/draw-a-change-as-a-diagram/do-work/graph-authoring.mjs
//
// ASKING A MODEL FOR A GRAPH DOCUMENT: THE VALIDATOR'S OWN RULES IN, THE HOST'S FACTS OVER, ONE REPAIR, SAFE WORDS OUT.
//
// Purpose: the model never draws; it writes a graph document (./graph-contract.mjs) and the layout draws it. This is the
// whole conversation around that one write. `graphAuthoringBrief` builds the system message and the schema from the
// contract's own DATA, so the model is told exactly what the validator will check. `authorGraphDocument` asks, parses,
// writes the host's facts over whatever the model put there, makes its words safe to paste anywhere, validates, and on a
// refusal asks once more with the validator's own findings (path, machine code, words), then fails with a typed code.
//
// Non-negotiable invariants:
//   1. The message and the schema are derived from ./graph-contract.json at call time; no state, kind or limit is written
//      here. The schema's field types and the message's templates are DATA (./graph-authoring.json).
//   2. Fields the host knows (DATA `host_fields`) are overwritten after parsing, never merged: a model cannot change them.
//   3. Model-authored words are flattened to one line and every sigil that would page a person or link a thing gets a
//      zero-width joiner (DATA `sigils`), before validation, so what is validated is what is shown.
//   4. Exactly `attempts` asks happen at most. Every refusal fed back is the validator's own path, code and words.
//   5. What the model is sent from a large input is chosen and filtered by ./author-input.mjs, and the exact list of it is
//      returned (and is all a dry run does).
//   6. `ask` is the only thing with a side effect, and it is handed in: nothing here reads a clock, a file or the network.
//
// Key concepts: `graphIdentifiers(document)`, `graphAuthoringBrief(rules?)`, `stampHostFields(document, host)`, `containModelText(text, rules?)`,
// `authorGraphDocument({ ask, request, host })`.

import authoring from '../read-data/graph-authoring.json' with { type: 'json' };
import contract from '../read-data/graph-contract.json' with { type: 'json' };
import { validateGraphDocument } from './graph-contract.mjs';
import { boundAuthorInput, outboundList } from './author-input.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));

/** The system message and the JSON Schema for a graph document, both derived from the contract. -> { system, schema } */
export function graphAuthoringBrief(rules = contract, words = authoring) {
  const system = words.brief.map((line) => fill(line, {
    forbidden: rules.forbidden_fields.join(', '),
    floor_most: rules.limits.floor_height_most,
    states: Object.keys(rules.delta.states).join(', '),
    node_kinds: Object.keys(rules.kinds.node).join(', '),
    edge_kinds: Object.keys(rules.kinds.edge).join(', '),
    unknown_kind: words.unknown_kind_words[rules.kinds.unknown],
    host: words.host_fields.join(', '),
    ...rules.limits,
  })).join('\n');
  const shape = (name) => {
    const properties = Object.fromEntries(rules.allowed_fields[name].map((field) => {
      const row = words.field_types[field];
      const entry = { type: row.type };
      if (row.enum_from) entry.enum = Object.keys(rules[row.enum_from].states);
      if (row.type === 'array') entry.items = shape(row.items);
      if (row.shape) Object.assign(entry, shape(row.shape));
      if (field === 'id') entry.pattern = rules.id_pattern;
      if (field === 'schema_version') { entry.minimum = rules.oldest_schema_version; entry.maximum = rules.schema_version; }
      return [field, entry];
    }));
    return { type: 'object', additionalProperties: false, required: words.required[name], properties };
  };
  return { system, schema: shape('document') };
}

/**
 * Names an AI can use directly as identifiers in code it writes, one per lane and node id: letter first, letters, digits and
 * underscore only, the same document always giving the same names, and two ids never sharing one. -> { byId: Map, byName: Map }
 */
export function graphIdentifiers(document, words = authoring) {
  const rule = words.identifiers;
  const pattern = new RegExp(rule.not_allowed, 'gu');
  const byId = new Map();
  const byName = new Map();
  for (const id of document.lanes.flatMap((lane) => [lane.id, ...lane.nodes.map((node) => node.id)])) {
    if (byId.has(id)) continue;
    let base = id.replace(pattern, rule.replacement);
    if (!/^[A-Za-z]/u.test(base)) base = `${rule.prefix}${base}`;
    let name = base;
    for (let count = 2; byName.has(name); count += 1) name = `${base}${rule.replacement}${count}`;
    byId.set(id, name);
    byName.set(name, id);
  }
  return { byId, byName };
}

/** `document` with the host's facts written over it. A copy; the model's version of those fields is gone. */
export const stampHostFields = (document, host) => ({ ...document, ...host });

/** Words from a model as one line, with each sigil that could page or link followed by a zero-width joiner. */
export function containModelText(text, words = authoring) {
  let flat = String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  for (const sigil of words.sigils) flat = flat.split(sigil).join(`${sigil}${words.joiner}`);
  return flat;
}

/** A copy of `value` with every model-authored text field made safe, at any depth. */
export function containDocumentText(value, words = authoring) {
  if (Array.isArray(value)) return value.map((item) => containDocumentText(item, words));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [
    key, words.text_fields.includes(key) && typeof inner === 'string' ? containModelText(inner, words) : containDocumentText(inner, words),
  ]));
}

/** The first JSON object in a model reply (an object already, a bare string, or a string inside a code fence), or null. */
export function readModelObject(reply) {
  if (isObject(reply)) return reply;
  if (typeof reply !== 'string') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(reply);
  const text = (fenced ? fenced[1] : reply);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const parsed = JSON.parse(text.slice(start, end + 1)); return isObject(parsed) ? parsed : null; } catch { return null; }
}

/** What goes back to the model after a refusal: the validator's own path, code and words, one line each. */
export const repairMessage = (errors, words = authoring) =>
  [words.repair.intro, ...errors.map((error) => fill(words.repair.line, error))].join('\n');

/**
 * Ask for a graph document about `request` until it validates or the attempts run out.
 * `ask({ system, schema, request, input, repair })` -> the model's reply (an object or text); `repair` is null on the first
 * ask and the previous refusal's message after. `host` holds the fields the host knows. `files` ([{ path, text }]) are the
 * large input: they are bounded and filtered first (./author-input.mjs) and `input` is only what may leave; `outbound` in
 * the answer is the exact list of what left and what stayed. With `dryRun`, nothing is asked and only that list is returned.
 * -> { ok, document | null, warnings, attempts, errors, outbound }
 */
export async function authorGraphDocument({ ask, request, host = {}, files = [], dryRun = false }, rules = contract, words = authoring) {
  const { system, schema } = graphAuthoringBrief(rules, words);
  const bounded = boundAuthorInput(files);
  const outbound = outboundList(bounded);
  if (dryRun) return { ok: true, document: null, warnings: [], attempts: 0, errors: [], outbound };
  const stamped = { schema_version: rules.schema_version, ...host };
  let repair = null;
  let errors = [];
  for (let attempt = 1; attempt <= words.attempts; attempt += 1) {
    const reply = await ask({ system, schema, request, input: bounded.sent, repair });
    const parsed = readModelObject(reply);
    if (!parsed) {
      errors = [{ code: 'UNREADABLE', path: 'reply', message: words.words.errors.UNREADABLE }];
      repair = words.repair.unreadable;
      continue;
    }
    const document = containDocumentText(stampHostFields(parsed, stamped), words);
    const checked = validateGraphDocument(document, rules);
    if (checked.ok) return { ok: true, document, warnings: checked.warnings, attempts: attempt, errors: [], outbound };
    errors = checked.errors;
    repair = repairMessage(checked.errors, words);
  }
  return { ok: false, document: null, warnings: [], attempts: words.attempts, outbound, errors: [{ code: 'STILL_INVALID', path: 'document', message: fill(words.words.errors.STILL_INVALID, { attempts: words.attempts }) }, ...errors] };
}
