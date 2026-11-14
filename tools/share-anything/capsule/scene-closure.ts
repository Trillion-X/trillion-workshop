// packages/public-scene-share/capsule/scene-closure.ts
//
// PURPOSE
// The bridge from a materialized scene tree to a `ClosureBuildInput` that
// `buildSceneCapsule` (closure-builder.ts) freezes. It does TWO pure things:
//   1. WALK the scene tree and collect every content-addressed reference it names
//      (a node's `component_id`, and any asset/byte references) into `CapsuleRef`s.
//   2. Build a `RefResolver` from caller-supplied subresource metadata (component
//      integrity hashes + transitive deps + public-readable flags + frozen data).
// The LIVE half — querying the engine for the scene entity + component metadata —
// is the do-work caller's job (T2b-live); this module is pure + fixture-testable.
//
// BLIND (L090): the walker NEVER switches on a node's `kind` (Component / Container
// / Text / anything). It collects a ref wherever a ref-CARRYING FIELD is present —
// `component_id` names a component subresource; entries in a node's asset-ref field
// name asset subresources. A new node kind that carries a `component_id` is covered
// for free; the walker learns nothing about node taxonomy.
//
// The scene tree shape it walks is the SceneNode the projector emits:
//   { id?, kind?, props?: { component_id?, things_to_put_on_screen?, ... }, children?: [...] }
// but the walker only depends on `children` (recursion) + the configured
// ref-bearing field names (DATA) — never on `kind`.

import { refKey } from './scene-capsule';
import type { CapsuleRef, CapsuleTier, ResolvedRef } from './scene-capsule';
import type { ClosureBuildInput, RefResolver } from './closure-builder';

/** Which fields on a scene node name content-addressed refs. DATA, not hardcoded. */
export interface RefFieldConfig {
  /** Node/prop field holding a single component id (e.g. `'component_id'`). */
  readonly componentIdField: string;
  /** Node/prop field holding an array of asset reference strings. */
  readonly assetRefsField: string;
  /** The kind tag stamped on a collected component ref (default `'component'`). */
  readonly componentKind: string;
  /** The kind tag stamped on a collected asset ref (default `'asset'`). */
  readonly assetKind: string;
}

export const DEFAULT_REF_FIELDS: RefFieldConfig = {
  componentIdField: 'component_id',
  assetRefsField: 'asset_refs',
  componentKind: 'component',
  assetKind: 'asset',
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Walk a scene tree (depth-first, order-preserved) and collect every CapsuleRef it
 * names. A node contributes a component ref if `componentIdField` is present on the
 * node OR its `props`; asset refs from `assetRefsField` (array of strings). Refs are
 * de-duplicated by `refKey` (the one canonical ref-key fn). Pure; no DOM, no I/O.
 */
export function collectSceneRefs(
  sceneTree: unknown,
  fields: RefFieldConfig = DEFAULT_REF_FIELDS,
): CapsuleRef[] {
  const out: CapsuleRef[] = [];
  const seen = new Set<string>();
  const push = (kind: string, id: unknown) => {
    if (typeof id !== 'string' || !id) return;
    const key = refKey({ kind, id });
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, id });
    }
  };
  const visit = (node: unknown) => {
    const obj = asObject(node);
    if (!obj) return;
    // A ref-bearing field may live on the node or under `props` — check both, blind to kind.
    const props = asObject(obj.props) ?? {};
    push(fields.componentKind, obj[fields.componentIdField] ?? props[fields.componentIdField]);
    for (const src of [obj[fields.assetRefsField], props[fields.assetRefsField]]) {
      if (Array.isArray(src)) for (const a of src) push(fields.assetKind, a);
    }
    const children = obj.children;
    if (Array.isArray(children)) for (const child of children) visit(child);
  };
  visit(sceneTree);
  return out;
}

/**
 * Build a `RefResolver` from a metadata map keyed by `refKey(ref)`. Each entry is the
 * `ResolvedRef` the closure builder needs (hash + public flag + transitive deps, or
 * a frozen data value). An unmapped ref resolves to `null` → fails reference closure
 * (no silent blank render). Pure.
 */
export function sceneRefResolver(meta: Record<string, ResolvedRef>): RefResolver {
  return (ref: CapsuleRef) => {
    const entry = meta[refKey(ref)];
    return entry ?? null;
  };
}

/**
 * Assemble the `ClosureBuildInput` for `buildSceneCapsule` from a scene tree + its
 * frozen chrome + subresource metadata. The caller (T2b-live) fetches `sceneTree`,
 * `frozenChrome` and `meta` from the engine; this stays pure.
 */
export function sceneClosureInput(args: {
  readonly sceneTree: unknown;
  readonly frozenChrome: unknown;
  readonly tier: CapsuleTier;
  readonly meta: Record<string, ResolvedRef>;
  readonly fields?: RefFieldConfig;
  readonly tierIsPublic?: (tier: CapsuleTier) => boolean;
}): ClosureBuildInput {
  return {
    sceneSnapshot: args.sceneTree,
    frozenChrome: args.frozenChrome,
    rootRefs: collectSceneRefs(args.sceneTree, args.fields ?? DEFAULT_REF_FIELDS),
    tier: args.tier,
    resolve: sceneRefResolver(args.meta),
    tierIsPublic: args.tierIsPublic,
  };
}
