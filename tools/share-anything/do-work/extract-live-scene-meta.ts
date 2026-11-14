// packages/public-scene-share/do-work/extract-live-scene-meta.ts
//
// PURPOSE
// The T2b-live scene reader: walk a LIVE materialized scene tree (as the projector
// emits it) and collect, per component, the SOURCE POINTER its bytes live at —
// `{ address, partition }`. This is the do-work caller's half: it knows the live
// projector scene FORMAT (where a component node names its byte source), which the
// pure `capsule/` modules deliberately do NOT (L098: live-format knowledge stays
// with the caller, never leaks into the format-blind closure builder).
//
// WHY SOURCES, NOT HASHES: a scene node references a component by a MUTABLE ADDRESS
// (`package::sidebar::entry-bytes::sidebar`), not by content hash — the hash is not
// inline in the scene. A content-addressed capsule needs the IMMUTABLE content
// hash, so the address is resolved → hash at publish by `resolve-component-meta.ts`
// (a live read). This module stays pure; it only reports what the scene NAMES.
//
// BLIND (L090): the walker NEVER switches on a node's `kind`. It contributes a
// component source wherever a `componentIdField` is present; a never-seen node kind
// that carries a component id is covered for free. A different scene byte-source
// layout is a different CONFIG, never a code change.
//
// The default config matches the projector scene sink verified live 2026-06-26
// (readCurrent addr `scene`): a Component node carries `props.component_id` and
// `props.things_to_put_on_screen[0].source_bytes.{address_label,partition_label}`.

import { refKey } from '../capsule/scene-capsule';

/** Where, on a live scene node, the component id and its byte SOURCE live. DATA. */
export interface LiveSceneSourceConfig {
  /** Node/prop field holding the component id (e.g. `'component_id'`). */
  readonly componentIdField: string;
  /** Prop field holding the array of on-screen byte refs (e.g. `'things_to_put_on_screen'`). */
  readonly bytesArrayField: string;
  /** Which entry of that array carries the primary byte source. */
  readonly bytesEntryIndex: number;
  /** Field on that entry holding the source pointer object (e.g. `'source_bytes'`). */
  readonly bytesSourceField: string;
  /** Field on the source pointer naming the byte address (e.g. `'address_label'`). */
  readonly bytesAddressField: string;
  /** Field on the source pointer naming the partition (e.g. `'partition_label'`). */
  readonly bytesPartitionField: string;
  /** The kind tag stamped on a collected component ref (default `'component'`); must
   *  match the mint side's `RefFieldConfig.componentKind` so the resolver keys align. */
  readonly componentKind: string;
}

export const DEFAULT_LIVE_SCENE_SOURCE_CONFIG: LiveSceneSourceConfig = {
  componentIdField: 'component_id',
  bytesArrayField: 'things_to_put_on_screen',
  bytesEntryIndex: 0,
  bytesSourceField: 'source_bytes',
  bytesAddressField: 'address_label',
  bytesPartitionField: 'partition_label',
  componentKind: 'component',
};

/**
 * The unresolved pointer a scene node names for a component's bytes. The do-work
 * resolver (`resolve-component-meta.ts`) freezes this MUTABLE address into the
 * component's immutable CONTENT hash at publish.
 */
export interface ComponentSource {
  readonly address: string;
  readonly partition?: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Walk a live scene tree and collect, keyed by `refKey({kind: componentKind, id})`, the byte SOURCE
 * each component names. An absent source yields an empty `address` — which the
 * resolver then resolves to an empty hash, which the reference-closure validator
 * rejects at publish (no silent blank render). Pure; no I/O.
 */
export function liveSceneComponentSources(
  sceneTree: unknown,
  config: LiveSceneSourceConfig = DEFAULT_LIVE_SCENE_SOURCE_CONFIG,
): Record<string, ComponentSource> {
  const sources: Record<string, ComponentSource> = {};
  const visit = (node: unknown) => {
    const obj = asObject(node);
    if (!obj) return;
    const props = asObject(obj.props) ?? {};
    const componentId = obj[config.componentIdField] ?? props[config.componentIdField];
    if (typeof componentId === 'string' && componentId) {
      const arr = props[config.bytesArrayField] ?? obj[config.bytesArrayField];
      const entry = Array.isArray(arr) ? asObject(arr[config.bytesEntryIndex]) : null;
      const src = asObject(entry?.[config.bytesSourceField]);
      sources[refKey({ kind: config.componentKind, id: componentId })] = {
        address: asString(src?.[config.bytesAddressField]),
        partition: src && typeof src[config.bytesPartitionField] === 'string'
          ? (src[config.bytesPartitionField] as string)
          : undefined,
      };
    }
    const children = obj.children;
    if (Array.isArray(children)) for (const child of children) visit(child);
  };
  visit(sceneTree);
  return sources;
}
