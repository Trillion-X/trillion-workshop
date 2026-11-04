// File: documents/read-data/resolve-component-instances.ts
//
// Purpose
//   The pure surface read-layer that turns the AUTHORED compact scene (which may
//   contain component INSTANCE nodes — nodes that REFERENCE a stored definition
//   instead of inlining its subtree) into the RESOLVED scene the engine lays out.
//   The engine never sees instances; it lays out concrete nodes. This is the
//   "named node tree + transclusion ref" primitive (Codex-converged 2026-06-23):
//   a component instance, a linked instance, and (structurally) a placeable
//   surface are all the SAME shape — a node that references a definition that one
//   GENERIC resolver expands. Adding a component type = adding a definition record,
//   zero resolver change (L069 / L090 / enum-dissolution).
//
// Non-Negotiable Invariants
//   * SSOT = the AUTHORED tree (instance nodes + overrides). It is what gets
//     PERSISTED. The resolved tree is layout-only and is NEVER persisted —
//     persisting the resolved (expanded) tree would destroy the ref form and kill
//     propagation forever. That "resolved-id persistence drift" is the exact
//     failure mode this module exists to prevent (Codex Q3, 2026-06-23).
//   * Engine stays BLIND: instance control data rides under `props`
//     (definition_ref / prop_overrides) as self-describing data the resolver
//     consumes and STRIPS before the engine sees the node. No engine concept.
//   * Deterministic ids: a definition's root expands to the instance's OWN id;
//     every other definition-local node `d` expands to `${instanceId}::${d}`.
//     Stable across re-resolution (same instance + same def node -> same id) so
//     propagation is a minimal engine diff and edits map back deterministically.
//     NEVER crypto.randomUUID here (that would re-mint ids every propagation).
//   * Generic overrides: an override is plain { props?, style?, text? } DATA,
//     overlaid uniformly. NEVER `if definition is button/card/chart` (Codex Q7).

import type { SceneNode } from './documents';

export const INSTANCE_NS = '::';
export const DEFINITION_REF_PROP = 'definition_ref';
export const PROP_OVERRIDES_PROP = 'prop_overrides';

/** A per-node local override applied during expansion (generic DATA, never typed per component). */
export type PropOverride = {
  props?: Record<string, unknown>;
  style?: Record<string, unknown>;
  text?: string;
};
/** Overrides keyed by the DEFINITION-LOCAL node id they target. */
export type PropOverrideMap = Record<string, PropOverride>;

/**
 * A reusable component definition. Stored IN the composition document
 * (`CompositionContent.definitions`, file-scoped like Figma) — persisted by the
 * existing document write path, no separate engine-write. The slash-menu reads it
 * as just another MaterialDescriptor; the resolver reads `.node` as the template.
 */
export type ComponentDefinitionRecord = {
  id: string;
  label: string;
  match_terms: string[];
  node: SceneNode;
  group?: string;
};

/** definitionId -> definition root node, for resolve/collapse. */
export function definitionsMapFrom(records: ComponentDefinitionRecord[] | undefined): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  for (const record of records ?? []) {
    if (record && typeof record.id === 'string' && record.node) map.set(record.id, record.node);
  }
  return map;
}

/** Walk an AUTHORED tree and index every instance: resolved-root id -> definitionId. */
export function instanceRootsFrom(tree: SceneNode | null): Map<string, string> {
  const roots = new Map<string, string>();
  walkInstances(tree, roots);
  return roots;
}
function walkInstances(node: SceneNode | null, into: Map<string, string>): void {
  if (!node) return;
  const defId = instanceDefinitionId(node);
  if (defId) { into.set(node.id, defId); return; } // an instance's own children are the ref, not authored
  for (const child of node.children ?? []) walkInstances(child, into);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The definition id a node references, or null if the node is not an instance. */
export function instanceDefinitionId(node: SceneNode): string | null {
  const ref = asRecord(node.props)[DEFINITION_REF_PROP];
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

function instanceOverrides(node: SceneNode): PropOverrideMap {
  return asRecord(asRecord(node.props)[PROP_OVERRIDES_PROP]) as PropOverrideMap;
}

/** Parse a resolved id into {instanceId, defLocalId} (inside an instance) or {plainId}. */
export function parseResolvedId(
  resolvedId: string,
): { instanceId: string; defLocalId: string } | { plainId: string } {
  const i = resolvedId.indexOf(INSTANCE_NS);
  if (i < 0) return { plainId: resolvedId };
  return { instanceId: resolvedId.slice(0, i), defLocalId: resolvedId.slice(i + INSTANCE_NS.length) };
}

/** Remove the authoring-only instance control props so the engine never sees them. */
function stripInstanceProps(node: SceneNode): SceneNode {
  const props = asRecord(node.props);
  if (!(DEFINITION_REF_PROP in props) && !(PROP_OVERRIDES_PROP in props)) return node;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (key !== DEFINITION_REF_PROP && key !== PROP_OVERRIDES_PROP) rest[key] = props[key];
  }
  return { ...node, props: rest };
}

/** Overlay a generic override onto a node (props/style merge, text via props.text). */
function applyOverride(node: SceneNode, override: PropOverride | undefined): SceneNode {
  if (!override) return node;
  let next = node;
  if (override.props) next = { ...next, props: { ...asRecord(next.props), ...override.props } };
  if (override.style) next = { ...next, style: { ...asRecord(next.style), ...override.style } };
  if (typeof override.text === 'string') next = { ...next, props: { ...asRecord(next.props), text: override.text } };
  return next;
}

/**
 * Expand every component instance in the authored tree into the resolved tree the
 * engine lays out. Identity when there are no instances. Cycle-guarded (a
 * component cannot contain itself) — on a cycle or a missing definition the node
 * renders as-is with its ref metadata stripped (honest: an unresolved ref shows
 * its placement, never throws).
 */
export function resolveComponentInstances(
  tree: SceneNode | null,
  definitionsById: Map<string, SceneNode>,
): SceneNode | null {
  if (!tree) return null;
  return resolveNode(tree, definitionsById, new Set<string>());
}

function resolveNode(node: SceneNode, defs: Map<string, SceneNode>, active: Set<string>): SceneNode {
  const defId = instanceDefinitionId(node);
  if (defId && defs.has(defId) && !active.has(defId)) {
    const def = defs.get(defId) as SceneNode;
    return expand(def, node.id, true, instanceOverrides(node), defs, new Set(active).add(defId));
  }
  const base = defId ? stripInstanceProps(node) : node; // cycle / missing def -> strip + render as-is
  const children = node.children ?? [];
  if (children.length === 0) return base;
  return { ...base, children: children.map((child) => resolveNode(child, defs, active)) };
}

function expand(
  defNode: SceneNode,
  instanceId: string,
  isRoot: boolean,
  overrides: PropOverrideMap,
  defs: Map<string, SceneNode>,
  active: Set<string>,
): SceneNode {
  const resolvedId = isRoot ? instanceId : `${instanceId}${INSTANCE_NS}${defNode.id}`;
  // A definition node may ITSELF be an instance (nested components). Expand it
  // under this resolved id as the new namespace, using its OWN authored overrides
  // merged under the outer override targeting this def-local id (root-level only).
  const nestedDefId = instanceDefinitionId(defNode);
  if (nestedDefId && defs.has(nestedDefId) && !active.has(nestedDefId)) {
    const nestedDef = defs.get(nestedDefId) as SceneNode;
    const nestedRoot = expand(nestedDef, resolvedId, true, instanceOverrides(defNode), defs, new Set(active).add(nestedDefId));
    return applyOverride(nestedRoot, overrides[defNode.id]); // outer override can touch the nested root
  }
  // Clone props/style so the resolved tree never ALIASES the definition's mutable
  // objects — a consumer (engine snapshot round-trip, a test, anything) mutating a
  // resolved node must NOT corrupt the shared definition.
  const cloned: SceneNode = {
    ...defNode,
    id: resolvedId,
    props: { ...asRecord(defNode.props) },
    ...(defNode.style ? { style: { ...asRecord(defNode.style) } } : {}),
  };
  const node = stripInstanceProps(applyOverride(cloned, overrides[defNode.id]));
  const kids = (defNode.children ?? []).map((child) => expand(child, instanceId, false, overrides, defs, active));
  return { ...node, children: kids };
}

// ---- collapse: the INVERSE of resolve — engine/resolved tree -> authored SSOT ----
//
// This is what the surface calls at PERSIST. All edits go to the engine as usual
// (the engine snapshot is the working render truth); at save time collapse rebuilds
// the compact authored tree, replacing each instance's expanded subtree with its
// ref node and EXTRACTING per-node overrides by diffing the actual resolved subtree
// against the definition's clean expansion. So a local edit inside an instance
// becomes a prop_override (local props for free); a STRUCTURAL change to an instance
// DETACHES it to a plain copy. collapse(resolve(authored)) == authored (proven).

function shallowDiff(actual: Record<string, unknown>, clean: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const key of Object.keys(actual)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(clean[key])) { out[key] = actual[key]; any = true; }
  }
  return any ? out : null;
}

function nodeOverride(actual: SceneNode, clean: SceneNode): PropOverride | null {
  const aProps = asRecord(actual.props), cProps = asRecord(clean.props);
  const propsDiff = shallowDiff(aProps, cProps);
  const styleDiff = shallowDiff(asRecord(actual.style), asRecord(clean.style));
  if (!propsDiff && !styleDiff) return null;
  const ov: PropOverride = {};
  if (propsDiff) ov.props = propsDiff; // text rides inside props.text — recovered uniformly
  if (styleDiff) ov.style = styleDiff;
  return ov;
}

// Walk actual vs clean in lockstep; collect overrides keyed by definition-local id.
// Returns false on any structural mismatch (-> the caller detaches the instance).
function collectOverrides(
  actual: SceneNode, clean: SceneNode, rootDefLocalId: string, isRoot: boolean, into: PropOverrideMap,
): boolean {
  const aKids = actual.children ?? [], cKids = clean.children ?? [];
  if (aKids.length !== cKids.length) return false;
  const parsed = parseResolvedId(actual.id);
  const defLocalId = isRoot ? rootDefLocalId : ('defLocalId' in parsed ? parsed.defLocalId : actual.id);
  const ov = nodeOverride(actual, clean);
  if (ov) into[defLocalId] = ov;
  for (let i = 0; i < aKids.length; i++) {
    if (aKids[i].id !== cKids[i].id) return false;
    if (!collectOverrides(aKids[i], cKids[i], rootDefLocalId, false, into)) return false;
  }
  return true;
}

/**
 * Rebuild the authored compact tree from the resolved (engine) tree.
 * `instanceRoots` maps each resolved instance-root id -> its definition id (the
 * surface tracks this from the authored tree's instance nodes). Identity when
 * `instanceRoots` is empty (no components) — so non-component scenes are untouched.
 */
export function collapseInstances(
  resolved: SceneNode | null,
  instanceRoots: Map<string, string>,
  definitionsById: Map<string, SceneNode>,
): SceneNode | null {
  if (!resolved) return null;
  return collapseNode(resolved, instanceRoots, definitionsById);
}

function collapseNode(node: SceneNode, roots: Map<string, string>, defs: Map<string, SceneNode>): SceneNode {
  const defId = roots.get(node.id);
  if (defId && defs.has(defId)) {
    const def = defs.get(defId) as SceneNode;
    const clean = expand(def, node.id, true, {}, defs, new Set([defId])); // no-override expansion
    const overrides: PropOverrideMap = {};
    const matched = collectOverrides(node, clean, def.id, true, overrides);
    if (!matched) {
      // structural change inside the instance -> detach to a plain copy
      return { ...stripInstanceProps(node), children: (node.children ?? []).map((c) => collapseNode(c, roots, defs)) };
    }
    return {
      id: node.id,
      kind: node.kind,
      props: {
        [DEFINITION_REF_PROP]: defId,
        ...(Object.keys(overrides).length ? { [PROP_OVERRIDES_PROP]: overrides } : {}),
      },
      visible: node.visible,
      children: [],
    };
  }
  const kids = node.children ?? [];
  if (kids.length === 0) return node;
  return { ...node, children: kids.map((c) => collapseNode(c, roots, defs)) };
}

// ---- reverse edit-map: a RESOLVED-id edit -> the AUTHORED tree (used at persist) ----

function setOverride(node: SceneNode, defLocalId: string, delta: PropOverride): SceneNode {
  const existing = instanceOverrides(node);
  const prior = existing[defLocalId] ?? {};
  const merged: PropOverride = {
    ...prior,
    ...(delta.props ? { props: { ...asRecord(prior.props), ...delta.props } } : {}),
    ...(delta.style ? { style: { ...asRecord(prior.style), ...delta.style } } : {}),
    ...(typeof delta.text === 'string' ? { text: delta.text } : {}),
  };
  return { ...node, props: { ...asRecord(node.props), [PROP_OVERRIDES_PROP]: { ...existing, [defLocalId]: merged } } };
}

function updateNodeById(node: SceneNode, id: string, fn: (n: SceneNode) => SceneNode): SceneNode {
  if (node.id === id) return fn(node);
  const children = node.children ?? [];
  if (children.length === 0) return node;
  return { ...node, children: children.map((child) => updateNodeById(child, id, fn)) };
}

/**
 * Map a RESOLVED-id prop/style/text edit back onto the AUTHORED tree so the edit
 * survives persistence WITHOUT collapsing the ref form (the two-tree invariant).
 *   - `instanceId::defLocalId`  -> write instance.prop_overrides[defLocalId]
 *   - a plain id that IS an instance root -> override keyed by the definition root id
 *   - any other plain id (non-instance node) -> apply the delta directly
 * Pure: returns a new authored tree.
 */
export function applyResolvedEditToAuthored(
  authored: SceneNode | null,
  resolvedId: string,
  delta: PropOverride,
  definitionsById: Map<string, SceneNode>,
): SceneNode | null {
  if (!authored) return authored;
  const parsed = parseResolvedId(resolvedId);
  if ('defLocalId' in parsed) {
    return updateNodeById(authored, parsed.instanceId, (inst) => setOverride(inst, parsed.defLocalId, delta));
  }
  return updateNodeById(authored, parsed.plainId, (node) => {
    const defId = instanceDefinitionId(node);
    if (defId && definitionsById.has(defId)) {
      const rootLocalId = (definitionsById.get(defId) as SceneNode).id;
      return setOverride(node, rootLocalId, delta);
    }
    return applyOverride(node, delta);
  });
}
