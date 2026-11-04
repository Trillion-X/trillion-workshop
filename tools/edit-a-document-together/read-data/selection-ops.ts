// packages/documents/read-data/selection-ops.ts
//
// The SELECTION-OP primitive (L069/L090/enum-dissolution) — the DATA registry behind EVERY multi-op a
// marquee/Cmd+A selection can run (delete, clear, duplicate, group, arrange, change-type, …). It is the
// selection twin of the input-shortcut registry: input-shortcut is "a gesture typed in a block → an
// effect on that block"; a selection-op is "a gesture pressed while a SET is selected → an effect over
// that set". Both are self-describing DATA rows read live BY KIND across the whole published-records
// feed — so a NEW op is ONE DATA row any package ships in its own things-to-store-and-run.json, ZERO
// surface code (the old hardcoded Delete→REMOVE_SUBTREE / Escape→clear keydown is dissolved into DATA).
//
// This file is PURE — zero DOM, zero React, zero engine imports — so the matching + patch-fanning logic
// is unit-testable in isolation; the surface only has to trust these functions. An op's effect is one
// of three self-describing shapes (the handler dispatches by SHAPE, never by a named op):
//   • { patch, props?, scope? } — a composition-engine ScenePatch fanned over the selected set. `patch`
//     is the mutation type string (REMOVE_SUBTREE, UPDATE_PROPS, …); `props` are merged in; `scope`
//     'roots' (default) fans over the subtree-root ids, 'each' over every selected id.
//   • { clear: true }          — clear the selection (a control op, no engine mutation).
//   • { dispatch: { target, payload? } } — send { selectedIds, …payload } as an Envelope to another
//     package (e.g. the group package's batch primitive) — the no-god-package reuse seam: the surface
//     names no group internals, it just forwards the set to a DATA-named address.

import { flattenProjectedRows, isRecord } from './documents.ts';

export type SelectionOpEffect =
  | { patch: string; props?: Record<string, unknown>; scope?: 'roots' | 'each' }
  | { clear: true }
  | { dispatch: { target: string; payload?: Record<string, unknown> } };

export type SelectionOp = {
  id: string;
  keys: string[]; // keyboard keys that fire this op (normalized from `key: string | string[]`)
  label: string;
  icon?: string;
  effect: SelectionOpEffect;
};

/** THE selection-op registry reader — the ONLY source of multi-ops at runtime (no code-constant
 *  fallback; the built-ins live as DATA in the log, L030/L101). Reads BY KIND across the ENTIRE feed:
 *  a row is an op if its payload is `{kind:"selection-op", …}` (an individual op any package ships) OR
 *  `{kind:"selection-op-set", rules:[…]}` (the compact seed), OR a bare array of ops. Later ids override
 *  earlier ids, so a package can shadow a built-in op by id. */
export function readSelectionOps(raw: unknown): SelectionOp[] {
  const byId = new Map<string, SelectionOp>();
  const add = (value: unknown) => {
    const op = toSelectionOp(value);
    if (op) byId.set(op.id, op);
  };
  for (const row of flattenProjectedRows(raw)) {
    const payload = isRecord(row) && 'payload' in row ? (row as { payload: unknown }).payload : row;
    if (isRecord(payload) && payload.kind === 'selection-op') add(payload);
    else if (isRecord(payload) && payload.kind === 'selection-op-set' && Array.isArray(payload.rules)) {
      for (const r of payload.rules) add(r);
    } else if (Array.isArray(payload)) {
      for (const r of payload) add(r);
    }
  }
  return [...byId.values()];
}

/** Map a self-describing DATA row to a runtime op. `key` accepts a single string or an array; the effect
 *  must be exactly one of the three shapes. Returns null (skipped) for a malformed row — never throws. */
function toSelectionOp(value: unknown): SelectionOp | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const label = typeof value.label === 'string' ? value.label : id;
  const keys = Array.isArray(value.key)
    ? value.key.filter((k): k is string => typeof k === 'string')
    : typeof value.key === 'string'
      ? [value.key]
      : [];
  const effect = toEffect(value.effect);
  if (!id || !label || !effect) return null;
  const op: SelectionOp = { id, keys, label, effect };
  if (typeof value.icon === 'string' && value.icon) op.icon = value.icon;
  return op;
}

function toEffect(value: unknown): SelectionOpEffect | null {
  if (!isRecord(value)) return null;
  if (value.clear === true) return { clear: true };
  if (isRecord(value.dispatch) && typeof value.dispatch.target === 'string') {
    const d: { target: string; payload?: Record<string, unknown> } = { target: value.dispatch.target };
    if (isRecord(value.dispatch.payload)) d.payload = value.dispatch.payload;
    return { dispatch: d };
  }
  if (typeof value.patch === 'string' && value.patch) {
    const e: { patch: string; props?: Record<string, unknown>; scope?: 'roots' | 'each' } = { patch: value.patch };
    if (isRecord(value.props)) e.props = value.props;
    if (value.scope === 'each' || value.scope === 'roots') e.scope = value.scope;
    return e;
  }
  return null;
}

/** Find the op fired by a keyboard key (first match wins, so earlier registry order = priority). */
export function matchSelectionOp(key: string, ops: readonly SelectionOp[]): SelectionOp | null {
  for (const op of ops) if (op.keys.includes(key)) return op;
  return null;
}

/** Pure: fan a scene-patch op over the selected set, producing the engine patches. `rootIds` are the
 *  subtree-root ids (ids not contained by another selected id — the caller computes containment); `each`
 *  scope patches every selected id, `roots` (default) only the roots (so REMOVE_SUBTREE never double-frees
 *  an already-removed descendant). Non-scene-patch effects (clear/dispatch) yield [] — the caller routes
 *  those. `node_id` + any `props` come straight from DATA; this names no patch type. */
export function selectionOpPatches(
  op: SelectionOp,
  rootIds: readonly string[],
  eachIds: readonly string[],
): Array<Record<string, unknown>> {
  const effect = op.effect;
  if (!('patch' in effect)) return [];
  const ids = effect.scope === 'each' ? eachIds : rootIds;
  const props = effect.props;
  // Spread DATA props FIRST so `type`/`node_id` always win — a malformed row can never override the
  // mutation type or target node id.
  return ids.map((id) => (props ? { ...props, type: effect.patch, node_id: id } : { type: effect.patch, node_id: id }));
}
