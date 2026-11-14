// packages/public-scene-share/capsule/closure-builder.ts
//
// PURPOSE
// The closure builder — the §6 "BIGGEST RISK" core. Given the scene's root refs
// and a resolver, it walks the TRANSITIVE closure of everything the scene needs,
// freezes each into the capsule (artifacts by hash, query results into
// `frozenData`), and runs the two publish gates (`closure-validators.ts`). It
// returns a `SceneCapsule` ONLY when the closure is complete and tier-valid;
// otherwise the capsule is `null` and the validation explains exactly why.
//
// FIRST-PRINCIPLES SHAPE
//   - BLIND TO SCENE FORMAT (L098): the builder NEVER parses `sceneSnapshot`. The
//     scene's owner (who knows its format) extracts the root refs and supplies a
//     `RefResolver`. The builder only chases refs → resolutions → transitive refs.
//   - CYCLE-SAFE + DEDUP: a ref is resolved at most once (keyed by `refKey`), so a
//     dependency cycle or a diamond terminates and each artifact appears once.
//   - DETERMINISTIC: artifacts + frozenData are sorted by `refKey`, so the same
//     scene always serializes to the same bytes ⇒ the same content hash (the whole
//     point of content-addressing). No clock, no randomness, no I/O — pure.
//   - NO SILENT FALLBACK: a ref that resolves to `null` is recorded as unresolved
//     and FAILS reference closure. The builder never invents a value or reaches
//     into live app state.

import {
  CAPSULE_MANIFEST_VERSION,
  refKey,
  type CapsuleArtifact,
  type CapsuleData,
  type CapsuleRef,
  type CapsuleTier,
  type ResolvedRef,
  type SceneCapsule,
} from './scene-capsule';
import { validateClosure, type ClosureValidation } from './closure-validators';

/** Resolve one ref to its bytes/data (+ transitive deps), or `null` if it cannot. */
export type RefResolver = (ref: CapsuleRef) => ResolvedRef | null;

export interface ClosureBuildInput {
  /** Opaque frozen scene tree — passed through verbatim, never parsed. */
  readonly sceneSnapshot: unknown;
  /** Opaque resolved ChromeVisibilityMap — passed through verbatim (D1: data). */
  readonly frozenChrome: unknown;
  /** The refs the scene directly needs (the scene owner extracts these). */
  readonly rootRefs: readonly CapsuleRef[];
  /** Which delivery tier this closure is being validated for (D2). */
  readonly tier: CapsuleTier;
  /** Resolve a ref to its resolution; `null` ⇒ unresolved ⇒ fails closure. */
  readonly resolve: RefResolver;
  /** Optional DATA-driven predicate for which tiers require a public closure. */
  readonly tierIsPublic?: (tier: CapsuleTier) => boolean;
}

export interface ClosureBuildResult {
  /** The publishable capsule, or `null` when `validation.ok` is false. */
  readonly capsule: SceneCapsule | null;
  readonly validation: ClosureValidation;
}

function byRefKey(a: { ref: CapsuleRef }, b: { ref: CapsuleRef }): number {
  const ka = refKey(a.ref);
  const kb = refKey(b.ref);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Freeze the transitive closure of `rootRefs` into a capsule and validate it.
 * Pure + deterministic — same input ⇒ same capsule bytes ⇒ same content hash.
 */
export function buildSceneCapsule(input: ClosureBuildInput): ClosureBuildResult {
  const seen = new Set<string>();
  const queue: CapsuleRef[] = [...input.rootRefs];
  let queueHead = 0;
  const artifacts: CapsuleArtifact[] = [];
  const frozenData: CapsuleData[] = [];
  const unresolved: CapsuleRef[] = [];

  // Index advancement keeps closure traversal O(roots + members + edges).
  // `shift()` reindexes every remaining member and becomes quadratic at the
  // 250,000-member closure boundary; this owner is the canonical membership
  // traversal, so that cost must not be inherited by every publication path.
  while (queueHead < queue.length) {
    const ref = queue[queueHead++]!;
    const key = refKey(ref);
    if (seen.has(key)) continue; // dedup + cycle-safe: resolve each ref once
    seen.add(key);

    const resolution = input.resolve(ref);
    if (!resolution) {
      unresolved.push(ref);
      continue;
    }

    if (resolution.is_data) {
      frozenData.push({ ref, value: resolution.value });
    } else {
      // An artifact: record it with its hash (a missing hash fails reference closure).
      artifacts.push({
        ref,
        integrity_hash: resolution.integrity_hash ?? '',
        public_readable: resolution.public_readable,
      });
    }

    // Chase transitive dependencies (resolved on later iterations; dedup guards cycles).
    for (const dep of resolution.dependencies ?? []) {
      if (!seen.has(refKey(dep))) queue.push(dep);
    }
  }

  artifacts.sort(byRefKey);
  frozenData.sort(byRefKey);

  const validation = validateClosure(input.tier, artifacts, unresolved, input.tierIsPublic);

  const capsule: SceneCapsule | null = validation.ok
    ? {
        manifestVersion: CAPSULE_MANIFEST_VERSION,
        tier: input.tier,
        sceneSnapshot: input.sceneSnapshot,
        frozenChrome: input.frozenChrome,
        artifacts,
        frozenData,
      }
    : null;

  return { capsule, validation };
}
