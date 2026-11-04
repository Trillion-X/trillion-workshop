// packages/documents/do-work/build-visibility-binding.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The PURE conditional-visibility primitive. A scene node's `visible` is not just
// a bool — the engine's `Visibility` is `Resolved(bool) | Binding(VisibilityBinding)`,
// and the KERNEL compute phase re-evaluates a visibility binding EVERY frame from
// live state and overlays `visible = Resolved(<bool>)` (composition-engine-core
// compute.rs). So a node can show/hide reactively from state with ZERO host code.
//
// This is the L069 generative primitive behind THREE MSG104 §C features — they are
// all configurations of "a node's `visible` is a binding to a state value":
//   • toggle visibility      → visible = bind(vars:showX)            (source already bool)
//   • conditional visibility → visible = bind(dataSource:…) + a transform (gt/contains/…)
//   • mode switch = branches → N nodes each bind(fsm:mode) + equals "<their value>"
//
// And it composes with the split layout node already shipped: a Split SKIPS
// invisible children and re-normalises the visible parts, so a bound-invisible
// column collapses and the rest re-expand for FREE — no new code (L063/L069).
//
// The engine binding AST (authoritative, from composition-ast types.rs):
//   visible = {
//     "$kind": "binding",
//     "select": { "from": "fsm"|"vars"|"dataSource"|"state"|…, "path": "fsm:mode" },
//     "transform": [{ "op": "op:core.equals", "args": { "value": "edit" } }],
//     "default": false
//   }
// `from` is OPEN (any source the owner wires); `op` is any op:core.* the executor
// knows (equals/not_equals/gt/gte/lt/lte/contains/includes/in_list/starts_with/
// is_null/is_not_null). This module NEVER enumerates sources or ops — they are
// data carried on the descriptor (L090). The panel renders {from,path,op,value};
// a new source or op is a data change, zero panel code.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { CompositionTransaction, SceneNode } from '../read-data/documents';

/** The engine's visibility-binding AST (untagged `Visibility::Binding`). */
export type VisibilityBinding = {
  $kind: 'binding';
  // `from` = the source family; `key` = WHICH source within a keyed family (the engine's
  // `dataSource` evaluator arm requires `select.key`, then reads `path` within it —
  // composition-engine-core binding/evaluator.rs); `path` = the field within the source.
  select: { from: string; key?: string; path?: string };
  transform?: Array<{ op: string; args: Record<string, unknown> }>;
  /** Resolved value when the binding fails (missing state/path). */
  default: boolean;
};

/** A node's `visible` is either a literal bool or a binding (engine `Visibility`). */
export type NodeVisibility = boolean | VisibilityBinding;

/** The human-authored condition, decoded from / encoded to the binding AST. */
export type VisibilityCondition = {
  /** State source — OPEN string ('fsm'|'vars'|'dataSource'|'state'|…); never enumerated here. */
  from: string;
  /** Path within the source, e.g. 'fsm:mode' or 'showDetails'. */
  path: string;
  /**
   * Comparison op (an `op:core.*` id). OMIT when the source value is ALREADY a
   * bool (a plain toggle) — then `visible` follows the source directly.
   */
  op?: string;
  /** Right-hand value for the op (e.g. the mode string to match). */
  value?: unknown;
  /**
   * Fallback when the binding can't resolve. Defaults to `true` for authored
   * content (a broken binding must NEVER silently hide a block) — but a
   * mode-branch caller passes `false` (an inactive branch stays hidden).
   */
  default?: boolean;
};

/**
 * Build the visibility-binding AST from a human condition. Generic over source
 * and op — both are data. With no `op`, the binding follows a boolean source
 * directly (a toggle); with an `op`, a one-step transform reduces the source
 * value to a bool (a condition / a mode-equals branch).
 */
export function buildVisibilityBinding(condition: VisibilityCondition): VisibilityBinding {
  const binding: VisibilityBinding = {
    $kind: 'binding',
    select: condition.path ? { from: condition.from, path: condition.path } : { from: condition.from },
    default: condition.default ?? true,
  };
  if (condition.op) {
    binding.transform = [{ op: condition.op, args: { value: condition.value } }];
  }
  return binding;
}

/** True when a node's `visible` is a binding (not a literal bool). */
export function isVisibilityBinding(visible: unknown): visible is VisibilityBinding {
  return isRecord(visible) && visible.$kind === 'binding' && isRecord(visible.select) && typeof visible.select.from === 'string';
}

/**
 * Resolve a node's `visible` field to a UI boolean, mirroring the engine's
 * `Visibility::as_bool()` (the SSOT). This is the ONE place the host decides
 * whether a node is shown when it only has authored data:
 *   - literal `false` → hidden
 *   - a binding → its `default` (the engine's as_bool fallback for an unresolved
 *     binding; the kernel overlays the live-resolved bool in the computed snapshot,
 *     but the host must agree on the fallback so split dividers / node rendering
 *     never disagree with the engine about a bound column's presence)
 *   - anything else (true / undefined) → shown
 * Using this everywhere a node's visibility gates UI (SceneNodeView render,
 * visibleDividerPairs) is what makes conditional-visibility compose with split:
 * a bound-hidden column is skipped by the SAME rule the engine uses.
 */
export function resolveVisibility(visible: unknown): boolean {
  if (visible === false) return false;
  if (isVisibilityBinding(visible)) return visible.default === true;
  return true;
}

/**
 * Decode a node's visibility binding back to the human condition, or null when
 * the node has a plain bool (or no) visibility. Tolerant of partial transforms.
 */
export function readNodeVisibilityCondition(node: SceneNode | null | undefined): VisibilityCondition | null {
  const visible = node?.visible as unknown;
  if (!isVisibilityBinding(visible)) return null;
  const first = Array.isArray(visible.transform) && visible.transform.length > 0 ? visible.transform[0] : null;
  return {
    from: visible.select.from,
    path: visible.select.path ?? '',
    op: first && typeof first.op === 'string' ? first.op : undefined,
    value: first && isRecord(first.args) ? first.args.value : undefined,
    default: typeof visible.default === 'boolean' ? visible.default : true,
  };
}

/** A node's location in its parent — what a full-node re-author needs to put it back. */
export type ParentLocation = { parentId: string; index: number };

/**
 * The transaction that sets a node's visibility — either a literal bool or a binding.
 *
 * The split here is PHYSICS, not a Society special case: the engine's `Visibility`
 * (Resolved(bool) | Binding) is a TOP-LEVEL `SceneNode` field re-evaluated each frame,
 * but the `UPDATE_PROPS` DELTA carries only RESOLVED values — `PropChanges.visible` is
 * `Option<bool>` (composition-ast `scene_diff_types.rs`), so it CANNOT carry a binding
 * (a binding object is rejected at decode → the whole transaction fails). Therefore:
 *   • a LITERAL bool → an `UPDATE_PROPS` delta (O(changed), no subtree re-emit);
 *   • a BINDING → re-author the FULL node (`REMOVE_SUBTREE` + `INSERT_NODE` carrying the
 *     node with `visible` set), the only patches that carry a whole `SceneNode`.
 * Remove-at-i then insert-at-i in ONE transaction restores the node's exact slot.
 * This is the engine's intended mechanism for authoring reactivity (bindings/triggers):
 * whole-node emission, never a delta. (Was task #18: the old code emitted the binding
 * via UPDATE_PROPS, which the engine rejected — the feature errored on first live use.)
 */
export function buildSetVisibilityTransaction(input: { node: SceneNode; parent: ParentLocation | null; visibility: NodeVisibility }): CompositionTransaction {
  if (typeof input.visibility === 'boolean') {
    return { scene_patches: [{ type: 'UPDATE_PROPS', node_id: input.node.id, changes: { visible: input.visibility } }] };
  }
  const fullNode: SceneNode = { ...input.node, visible: input.visibility };
  if (!input.parent) {
    // The ROOT has no parent to re-insert under — `REMOVE_SUBTREE` cannot remove the
    // root (scene_diff_apply.rs:725). The root re-seats via a SOLE `SET_ROOT`, the one
    // patch that replaces the root node and MUST be the only patch in its transaction
    // (scene_diff_apply.rs:305). So a root binding is NOT a silent no-op — it rides
    // SET_ROOT, carrying the binding on the full node's top-level `visible`. (Codex-converged.)
    return { scene_patches: [{ type: 'SET_ROOT', node: fullNode }] };
  }
  return {
    scene_patches: [
      { type: 'REMOVE_SUBTREE', node_id: input.node.id },
      { type: 'INSERT_NODE', parent_id: input.parent.parentId, index: input.parent.index, node: fullNode },
    ],
  };
}

/** Convenience: bind a node's visibility to a condition in one call (full-node re-author). */
export function buildBindVisibilityTransaction(input: { node: SceneNode; parent: ParentLocation | null; condition: VisibilityCondition }): CompositionTransaction {
  return buildSetVisibilityTransaction({ node: input.node, parent: input.parent, visibility: buildVisibilityBinding(input.condition) });
}

/** Remove a visibility binding — the node becomes unconditionally visible (a literal-bool delta). */
export function buildClearVisibilityTransaction(node: SceneNode): CompositionTransaction {
  return buildSetVisibilityTransaction({ node, parent: null, visibility: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
