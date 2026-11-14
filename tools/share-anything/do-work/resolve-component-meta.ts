// packages/public-scene-share/do-work/resolve-component-meta.ts
//
// PURPOSE
// Freeze each scene component's MUTABLE source address into its IMMUTABLE content
// hash — the step that makes a capsule truly content-addressed and CAS-fetchable.
// A live scene names a component by address (`package::sidebar::entry-bytes::…`);
// a capsule must carry the component's content hash so a no-account viewer can
// fetch the exact frozen bytes from `/cas/<hash>` forever. This module turns the
// `ComponentSource` pointers (`extract-live-scene-meta.ts`) into the
// `Record<refKey, ResolvedRef>` the pure closure pipeline (`mintCapsule`) consumes.
//
// PURE over injected I/O: the address→hash read is `resolveHash` (injected), so
// this orchestration is unit-testable and the live adapter (read the component
// address's current bytes → `makeHashCodeHexFromBytes`) stays at the boundary.
//
// FAIL-OPEN-TO-VALIDATOR: an address that resolves to '' stays '' → the
// reference-closure validator rejects the capsule at publish (no silent blank
// render). Tier policy (`publicReadable`) is the caller's, never the scene's.

import type { ResolvedRef } from '../capsule/scene-capsule';
import type { ComponentSource } from './extract-live-scene-meta';

/** Resolve a component's source pointer to its immutable CAS content hash. Live I/O. */
export type ComponentHashResolver = (source: ComponentSource) => Promise<string>;

export interface ResolveComponentMetaOptions {
  /** Tier policy: is each resolved component independently public on the CDN tier? */
  readonly publicReadable?: boolean;
}

/**
 * Resolve every component SOURCE into a `ResolvedRef` whose `integrity_hash` is the
 * component's content hash. Preserves the `refKey` keying so the closure resolver
 * matches the scene's collected refs. Pure over the injected `resolveHash`.
 */
export async function resolveComponentMeta(
  sources: Record<string, ComponentSource>,
  resolveHash: ComponentHashResolver,
  options: ResolveComponentMetaOptions = {},
): Promise<Record<string, ResolvedRef>> {
  const meta: Record<string, ResolvedRef> = {};
  for (const [refKey, source] of Object.entries(sources)) {
    meta[refKey] = {
      integrity_hash: await resolveHash(source),
      public_readable: options.publicReadable ?? true,
    };
  }
  return meta;
}
