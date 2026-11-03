// parts/ui/show/layer-diagram/graph-patch.mjs
//
// A GRAPH DOCUMENT THAT CHANGES BY TYPED OPERATIONS, AND HUMAN FIXES THAT OUTLIVE REGENERATION.
//
// Purpose: a stored graph document (./graph-contract.mjs) is evolved, not rewritten. A patch names the document it was
// written against (`from`, the BLAKE3 identity of its data), the operations in order, and the document it must give
// (`to`). Applying checks `from` against the document in hand, stops at the first operation that cannot apply, checks the
// whole result with the contract, and checks `to` against what came out, so a patch written against an older document is
// refused instead of landing somewhere it was never meant for. Corrections are the second use of the same operations:
// a person's rename, exclusion, re-description or move is kept as rows beside an inferred document, selected by node id
// or glob, and applied again after every regeneration without ever editing the inferred layer.
//
// Non-negotiable invariants:
//   1. This file names no operation, no scope and no field. Operations (`ops`), the places a document keeps things
//      (`scopes`), the correction plan and every refusal's words are DATA (./graph-patch.json); which fields may be set
//      comes from ./graph-contract.json's allowed_fields. A new operation is a row.
//   2. Operations apply in order on a copy. The first failure answers its machine code, its path (`ops[3].id`) and nothing
//      else; the document in hand is never changed.
//   3. Removing a thing removes what points at it (DATA `referenced_by`) and what it holds (`children`), so a result never
//      holds a broken reference.
//   4. The result is the contract's to judge: a patch that leaves an invalid document is refused with INVALID_RESULT.
//   5. Identities are the declared 1f BLAKE3 identity of the document as data with sorted keys, so key order never
//      changes it (graphIdentity in ./graph-contract.mjs).
//   6. Corrections report the selectors that matched nothing (`unmatched`), so a fix that went stale is seen, not lost.
//
// Key concepts: `applyGraphPatch(document, patch)`, `applyGraphOps(document, ops)`, `applyGraphCorrections(document, corrections)`.

import patchRules from './graph-patch.json' with { type: 'json' };
import contract from './graph-contract.json' with { type: 'json' };
import { graphIdentity, validateGraphDocument } from './graph-contract.mjs';
import { selectorTest } from './select-glob.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));

class Refusal extends Error {
  constructor(code, path, values = {}) { super(code); this.code = code; this.path = path; this.values = values; }
}

const finding = (rules, error) => ({ code: error.code, path: error.path, message: fill(rules.words.errors[error.code], { path: error.path, ...error.values }) });

const settableFields = (rules, contractRules, scopeName) => {
  const scope = rules.scopes[scopeName];
  if (scope.settable_only) return scope.settable_only;
  return contractRules.allowed_fields[scope.settable_from].filter((field) => !scope.keys.includes(field));
};

/** Every place of `scopeName` in `document`: [{ owner, list }] (the thing that holds the list, and the list). */
function holders(rules, document, scopeName) {
  const scope = rules.scopes[scopeName];
  if (scope.parent === 'document') return [{ owner: document, list: document[scope.collection] }];
  return holders(rules, document, scope.parent).flatMap(({ list }) => list.map((owner) => ({ owner, list: owner[scope.collection] })));
}

function locate(rules, document, scopeName, keys) {
  const scope = rules.scopes[scopeName];
  for (const held of holders(rules, document, scopeName)) {
    const index = held.list.findIndex((item) => scope.keys.every((key) => item[key] === keys[key]));
    if (index >= 0) return { ...held, index, item: held.list[index] };
  }
  return null;
}

const keysOf = (rules, scopeName, source) => Object.fromEntries(rules.scopes[scopeName].keys.map((key) => [key, source?.[key]]));
const named = (keys) => Object.values(keys).join(' to ');

/** Insert `item` into `list` after the item whose first key is `after`, or at the end. */
function insert(rules, scopeName, list, item, after, path) {
  if (after === undefined) { list.push(item); return; }
  const [first] = rules.scopes[scopeName].keys;
  const at = list.findIndex((other) => other[first] === after);
  if (at < 0) throw new Refusal('AFTER_NOT_FOUND', `${path}.after`, { found: after });
  list.splice(at + 1, 0, item);
}

/** Remove from `document` everything that points at `item` of `scopeName`, and everything it holds. */
function dropReferences(rules, document, scopeName, item) {
  const scope = rules.scopes[scopeName];
  if (scope.children) for (const child of item[scope.children.collection] ?? []) dropReferences(rules, document, scope.children.scope, child);
  for (const [pointerScope, fields] of Object.entries(scope.referenced_by ?? {})) {
    const pointers = rules.scopes[pointerScope];
    document[pointers.collection] = document[pointers.collection].filter((pointer) => !fields.some((field) => pointer[field] === item[scope.keys[0]]));
  }
}

function applyOp(rules, contractRules, document, op, path) {
  const row = rules.ops[op.op];
  const scope = rules.scopes[row.scope];
  if (row.action === 'set') {
    const target = row.scope === 'document' ? { item: document } : locate(rules, document, row.scope, keysOf(rules, row.scope, op));
    if (!target) throw new Refusal('NOT_FOUND', path, { scope: row.scope, found: named(keysOf(rules, row.scope, op)) });
    const allowed = settableFields(rules, contractRules, row.scope);
    for (const [field, value] of Object.entries(op.set)) {
      if (!allowed.includes(field)) throw new Refusal('NOT_SETTABLE', `${path}.set.${field}`, { found: field, scope: row.scope, settable: allowed.join(', ') });
      if (value === null) delete target.item[field]; else target.item[field] = structuredClone(value);
    }
    return;
  }
  if (row.action === 'add') {
    const value = structuredClone(op.value);
    const keys = keysOf(rules, row.scope, value);
    if (locate(rules, document, row.scope, keys)) throw new Refusal('ALREADY_EXISTS', `${path}.value`, { scope: row.scope, found: named(keys) });
    if (scope.children && value[scope.children.collection] === undefined) value[scope.children.collection] = [];
    const list = scope.parent === 'document' ? document[scope.collection] : (() => {
      const parentScope = rules.scopes[scope.parent];
      const parent = locate(rules, document, scope.parent, { [parentScope.keys[0]]: op[scope.parent] });
      if (!parent) throw new Refusal('NOT_FOUND', `${path}.${scope.parent}`, { scope: scope.parent, found: op[scope.parent] });
      return parent.item[scope.collection];
    })();
    insert(rules, row.scope, list, value, op.after, path);
    return;
  }
  const keys = keysOf(rules, row.scope, op);
  const target = locate(rules, document, row.scope, keys);
  if (!target) throw new Refusal('NOT_FOUND', path, { scope: row.scope, found: named(keys) });
  if (row.action === 'remove') {
    dropReferences(rules, document, row.scope, target.item);
    target.list.splice(target.index, 1);
    return;
  }
  // move: take it out of where it is and put it in the named parent, after `after` or last.
  const parentScope = rules.scopes[scope.parent];
  const parent = locate(rules, document, scope.parent, { [parentScope.keys[0]]: op[scope.parent] });
  if (!parent) throw new Refusal('NOT_FOUND', `${path}.${scope.parent}`, { scope: scope.parent, found: op[scope.parent] });
  target.list.splice(target.index, 1);
  insert(rules, row.scope, parent.item[scope.collection], target.item, op.after, path);
}

function checkOp(rules, op, path) {
  if (!isObject(op)) throw new Refusal('NOT_AN_OBJECT', path);
  if (typeof op.op !== 'string' || !Object.hasOwn(rules.ops, op.op)) throw new Refusal('UNKNOWN_OP', `${path}.op`, { found: String(op.op), ops: Object.keys(rules.ops).join(', ') });
  const row = rules.ops[op.op];
  for (const field of row.required) if (op[field] === undefined || op[field] === null) throw new Refusal('MISSING_FIELD', `${path}.${field}`);
  for (const field of Object.keys(op)) if (field !== 'op' && !row.required.includes(field) && !row.optional.includes(field)) throw new Refusal('UNKNOWN_FIELD', `${path}.${field}`);
  for (const field of ['value', 'set']) if (op[field] !== undefined && !isObject(op[field])) throw new Refusal('WRONG_TYPE', `${path}.${field}`, { expected: 'an object' });
  for (const field of Object.keys(op)) if (field !== 'op' && field !== 'value' && field !== 'set' && typeof op[field] !== 'string') throw new Refusal('WRONG_TYPE', `${path}.${field}`, { expected: 'a string' });
}

/**
 * `ops` applied in order to a copy of `document`, then judged by the graph contract.
 * -> { ok, errors: [{ code, path, message }], document | null }. The document in hand is never changed.
 */
export function applyGraphOps(document, ops, rules = patchRules, contractRules = contract) {
  const fail = (error) => ({ ok: false, errors: [finding(rules, error)], document: null });
  if (!Array.isArray(ops)) return fail(new Refusal('WRONG_TYPE', 'ops', { expected: 'a list' }));
  if (ops.length > rules.most_ops) return fail(new Refusal('TOO_MANY_OPS', 'ops', { most: rules.most_ops }));
  const copy = structuredClone(document);
  try {
    ops.forEach((op, index) => {
      const path = `ops[${index}]`;
      checkOp(rules, op, path);
      applyOp(rules, contractRules, copy, op, path);
    });
  } catch (error) {
    if (error instanceof Refusal) return fail(error);
    throw error;
  }
  const checked = validateGraphDocument(copy, contractRules);
  if (!checked.ok) return { ok: false, errors: [finding(rules, new Refusal('INVALID_RESULT', 'result', { first: checked.errors[0].message })), ...checked.errors], document: null };
  return { ok: true, errors: [], document: copy };
}

/**
 * A patch `{ graph, from, to, ops }` applied to `document`: the graph must be this one, `from` its identity now, and
 * `to` the identity of what the operations give. -> { ok, errors, document | null, identity | null }
 */
export function applyGraphPatch(document, patch, rules = patchRules, contractRules = contract) {
  const fail = (error) => ({ ok: false, errors: [finding(rules, error)], document: null, identity: null });
  if (!isObject(patch)) return fail(new Refusal('NOT_AN_OBJECT', 'patch'));
  for (const field of Object.keys(patch)) if (!rules.patch_fields.includes(field)) return fail(new Refusal('UNKNOWN_FIELD', `patch.${field}`));
  for (const field of rules.patch_fields) if (patch[field] === undefined || patch[field] === null) return fail(new Refusal('MISSING_FIELD', `patch.${field}`));
  if (patch.graph !== document.id) return fail(new Refusal('WRONG_GRAPH', 'patch.graph', { found: patch.graph, expected: document.id }));
  const base = graphIdentity(document);
  if (patch.from !== base) return fail(new Refusal('STALE_BASE', 'patch.from', { found: patch.from, expected: base }));
  const applied = applyGraphOps(document, patch.ops, rules, contractRules);
  if (!applied.ok) return { ...applied, identity: null };
  const result = graphIdentity(applied.document);
  if (patch.to !== result) return fail(new Refusal('RESULT_MISMATCH', 'patch.to', { found: result, expected: patch.to }));
  return { ok: true, errors: [], document: applied.document, identity: result };
}


/**
 * `corrections` (rows of { select, exclude?, label?, detail?, lane? }) applied to a copy of `document`, in the order the
 * rows are kept. A row selects every node whose id equals `select` or matches it as a glob.
 * -> { ok, errors, document | null, applied, unmatched: [select] }
 */
export function applyGraphCorrections(document, corrections, rules = patchRules, contractRules = contract) {
  const plan = rules.corrections;
  const fail = (error) => ({ ok: false, errors: [finding(rules, error)], document: null, applied: 0, unmatched: [] });
  if (!Array.isArray(corrections)) return fail(new Refusal('WRONG_TYPE', 'corrections', { expected: 'a list' }));
  if (corrections.length > plan.most) return fail(new Refusal('TOO_MANY_OPS', 'corrections', { most: plan.most }));
  const nodeIds = document.lanes.flatMap((lane) => lane.nodes.map((node) => node.id));
  const gone = new Set();
  const unmatched = [];
  const ops = [];
  for (const [index, row] of corrections.entries()) {
    const path = `corrections[${index}]`;
    if (!isObject(row)) return fail(new Refusal('NOT_AN_OBJECT', path));
    for (const field of Object.keys(row)) if (!plan.fields.includes(field)) return fail(new Refusal('UNKNOWN_FIELD', `${path}.${field}`));
    if (typeof row.select !== 'string' || !row.select) return fail(new Refusal('MISSING_FIELD', `${path}.select`));
    const matches = selectorTest(row.select, rules.glob_wildcard);
    const matched = nodeIds.filter((id) => matches(id) && !gone.has(id));
    if (!matched.length) { unmatched.push(row.select); continue; }
    for (const id of matched) {
      for (const step of plan.plan) {
        if (!row[step.when] || gone.has(id)) continue;
        const op = { op: step.op, id };
        for (const [destination, field] of Object.entries(step.take)) {
          const [head, tail] = destination.split('.');
          if (tail) op[head] = { ...(op[head] ?? {}), [tail]: row[field] }; else op[head] = row[field];
        }
        ops.push(op);
        if (step.op === 'remove_node') gone.add(id);
      }
    }
  }
  const applied = applyGraphOps(document, ops, rules, contractRules);
  return { ok: applied.ok, errors: applied.errors, document: applied.document, applied: applied.ok ? ops.length : 0, unmatched };
}
