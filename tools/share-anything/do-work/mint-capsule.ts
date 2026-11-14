// packages/public-scene-share/do-work/mint-capsule.ts
//
// PURPOSE
// The publisher orchestration (T2 / T2b-live): turn a live scene + its resolved
// subresource metadata into a content-addressed capsule, hash it, and write the
// bytes to CAS — returning the capsule hash + its `/c/<hash>` content path. This is
// the do-work that a `public-scene-share.create-capsule` target invokes.
//
// PURE ORCHESTRATION (deps injected → testable; live wiring stays at the boundary):
//   - `hashBytes`  = the runtime SSOT content hash (`makeHashCodeHexFromBytes`).
//   - `storeBytes` = the CAS write (engine.operation.write-batch); local CAS today,
//      a public HTTPS CAS origin once T3 stands one up — the bytes are IDENTICAL,
//      only the serving origin changes. So this module never blocks on the origin.
//   - `meta`       = the resolved subresource map (T2b-live extracts it from the
//      live scene's `things_to_put_on_screen` byte refs — see the faithful proof).
//
// FAIL-CLOSED: an incomplete/tier-invalid closure returns a structured failure and
// writes NOTHING — a half-published capsule (blank render / leaked gated bytes) is
// never created.

import { canonicalCapsuleBytes, capsuleContentPath } from '../capsule/capsule-bytes';
import { buildSceneCapsule } from '../capsule/closure-builder';
import { sceneClosureInput, type RefFieldConfig } from '../capsule/scene-closure';
import type { CapsuleTier, ResolvedRef } from '../capsule/scene-capsule';
import type { ClosureValidation } from '../capsule/closure-validators';

/** The canonical content type a capsule's bytes are served as. */
export const CAPSULE_CONTENT_TYPE = 'application/bitfield-scene-capsule+json';

export interface MintCapsuleArgs {
  readonly sceneTree: unknown;
  readonly frozenChrome: unknown;
  readonly tier: CapsuleTier;
  readonly meta: Record<string, ResolvedRef>;
  readonly fields?: RefFieldConfig;
  readonly tierIsPublic?: (tier: CapsuleTier) => boolean;
  /** Runtime SSOT content hash over the capsule's canonical bytes. */
  readonly hashBytes: (bytes: Uint8Array) => string;
  /** Persist the capsule bytes to CAS (local today, public origin once T3 exists). */
  readonly storeBytes: (bytes: Uint8Array, contentType: string) => Promise<void>;
}

export type MintCapsuleResult =
  | { readonly ok: true; readonly capsuleHash: string; readonly contentPath: string; readonly byteLength: number }
  | { readonly ok: false; readonly validation: ClosureValidation };

/**
 * Build + content-address + persist a capsule from a live scene. Returns the hash
 * and `/c/<hash>` path on success; a structured validation failure (and writes
 * nothing) when the closure is incomplete or tier-invalid.
 */
export async function mintCapsule(args: MintCapsuleArgs): Promise<MintCapsuleResult> {
  const { capsule, validation } = buildSceneCapsule(
    sceneClosureInput({
      sceneTree: args.sceneTree,
      frozenChrome: args.frozenChrome,
      tier: args.tier,
      meta: args.meta,
      fields: args.fields,
      tierIsPublic: args.tierIsPublic,
    }),
  );
  if (!capsule) return { ok: false, validation };

  const bytes = canonicalCapsuleBytes(capsule);
  const capsuleHash = args.hashBytes(bytes);
  await args.storeBytes(bytes, CAPSULE_CONTENT_TYPE);
  return { ok: true, capsuleHash, contentPath: capsuleContentPath(capsuleHash), byteLength: bytes.byteLength };
}
