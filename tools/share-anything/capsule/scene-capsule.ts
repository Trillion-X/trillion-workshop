// packages/public-scene-share/capsule/scene-capsule.ts
//
// PURPOSE
// The machine-readable schema for a `SceneCapsule` — the content-addressed,
// immutable unit that carries a whole frozen scene (its tree + present chrome +
// every content-addressed subresource it needs + the data it read at publish) to
// a no-account browser. The URL path IS the capsule's content hash. This file is
// pure data shapes + invariants; the closure builder (`closure-builder.ts`) mints
// one and the validators (`closure-validators.ts`) prove it is publishable.
//
// NON-NEGOTIABLE INVARIANTS
//   - CONTENT-ADDRESSED / IMMUTABLE: a capsule's bytes are hashed; the same bytes
//     always yield the same hash. It carries NO per-viewer state. (Codex
//     convergence D2.2: a per-viewer `accessLease` cannot live in immutable
//     content-addressed bytes — it lives in the MUTABLE `/s` resolution envelope,
//     never here.)
//   - BLIND (L090): the capsule logic NEVER branches on a ref's `kind`
//     (component / module / asset / data / anything future). `kind` is OPEN DATA
//     carried for the renderer that resolves the ref. There is ONE `artifacts[]`
//     list, not three kind-buckets (component/dependency/asset) — those would be a
//     closed artifact-category enum (enum-dissolution / L100). To the capsule,
//     every content-addressed subresource is identical: a hash + a public-readable
//     flag + a self-describing ref.
//   - SCENE-FORMAT AGNOSTIC (L098): the capsule logic NEVER parses `sceneSnapshot`
//     or `frozenChrome`. They are opaque to it. The scene's owner extracts the
//     refs and supplies them; the capsule only freezes + validates the closure.

/** The manifest version — config (Society), bumped when the schema changes. */
export const CAPSULE_MANIFEST_VERSION = 'scene-capsule/1';

/**
 * A self-describing reference to a content-addressed subresource (or a data read)
 * the scene needs. `kind` is OPEN DATA — the capsule logic never enumerates it.
 * `id` is unique within its kind (e.g. a `component_id`, a CAS hash, a query id).
 */
export interface CapsuleRef {
  readonly kind: string;
  readonly id: string;
}

/**
 * What a `RefResolver` returns for one ref (see `closure-builder.ts`). A resolution
 * is EITHER an artifact (bytes by hash) or a data read (`is_data`), and may pull in
 * transitive `dependencies` (themselves refs the builder will resolve).
 */
export interface ResolvedRef {
  /** CAS content id. Required for an artifact; absent/ignored for a data read. */
  readonly integrity_hash?: string;
  /** Is this subresource INDEPENDENTLY fetchable on the public tier? (tier-closure) */
  readonly public_readable: boolean;
  /** Transitive refs this one pulls in (component deps, nested assets, …). */
  readonly dependencies?: readonly CapsuleRef[];
  /** true → this resolution is a frozen query result (→ `frozenData`), not bytes. */
  readonly is_data?: boolean;
  /** The resolved value, frozen into `frozenData` when `is_data`. */
  readonly value?: unknown;
}

/** One frozen content-addressed subresource in the capsule. */
export interface CapsuleArtifact {
  readonly ref: CapsuleRef;
  readonly integrity_hash: string;
  /** Independently public on the CDN tier — drives tier-closure validation. */
  readonly public_readable: boolean;
}

/** One frozen query result the scene read at publish (never re-queried at view). */
export interface CapsuleData {
  readonly ref: CapsuleRef;
  readonly value: unknown;
}

/**
 * OPEN tier discriminant (e.g. `'public'` | `'gated'`) — DATA, never a closed enum.
 * Which delivery tier the closure was validated for (D2). A `'public'`-style tier
 * is served on the non-revocable public CDN; a `'gated'`-style tier sits behind a
 * lease-checked origin (the lease lives in the `/s` envelope, not the capsule).
 */
export type CapsuleTier = string;

/**
 * The content-addressed, immutable capsule. Published as opaque bytes to a public
 * HTTPS CAS origin; the URL path is its hash. Renders in a no-account browser via
 * the generic capsule shell (T5) — the cross-origin sandbox evaluates the artifact
 * bytes, the trusted shell renders `frozenChrome` as data.
 */
export interface SceneCapsule {
  readonly manifestVersion: string;
  readonly tier: CapsuleTier;
  /** Opaque frozen scene tree (roots + component refs). Blind to the capsule. */
  readonly sceneSnapshot: unknown;
  /** Opaque resolved ChromeVisibilityMap, frozen in (D1: crosses the sandbox as data). */
  readonly frozenChrome: unknown;
  /** EVERY content-addressed subresource, self-describing its `kind`. (Generic — not
   *  separate component/dependency/asset buckets.) Sorted for deterministic bytes. */
  readonly artifacts: readonly CapsuleArtifact[];
  /** The resolved query results the scene read at publish. Sorted for determinism. */
  readonly frozenData: readonly CapsuleData[];
}

/** Stable identity key for a ref (dedup + deterministic ordering). */
export function refKey(ref: CapsuleRef): string {
  return `${ref.kind}\u0000${ref.id}`;
}
