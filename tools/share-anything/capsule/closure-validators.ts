// packages/public-scene-share/capsule/closure-validators.ts
//
// PURPOSE
// The two gates that decide whether a built closure is PUBLISHABLE. A capsule is
// only safe to ship when BOTH hold:
//   1. REFERENCE CLOSURE — every ref the scene needs resolved to either an artifact
//      (with a hash) or a frozen data value. An unresolved ref ⇒ the recipient
//      (who has no live engine) renders blank/broken. So an unresolved ref FAILS
//      publish (the biggest risk in §6 FMEA), it never degrades silently.
//   2. TIER CLOSURE (Codex convergence D2.1) — a capsule served on the
//      non-revocable PUBLIC CDN tier must contain ONLY independently-public
//      subresources. A gated subresource embedded in a public capsule would leak
//      its bytes onto the public tier (the secret-on-CDN failure, one hop removed).
//      Fails at PUBLISH, not at fetch.
//
// BLIND: neither validator inspects a ref's `kind` or the opaque scene/chrome. The
// reference validator checks presence; the tier validator checks the public flag.
// Whether a tier "requires public closure" is DATA (a predicate the caller supplies,
// defaulting to the `'public'` tier), never a hardcoded Society branch in logic.

import type { CapsuleArtifact, CapsuleRef, CapsuleTier } from './scene-capsule';

/** A ref that could not be fully resolved into the closure. */
export interface ReferenceClosureIssue {
  readonly ref: CapsuleRef;
  readonly reason: 'unresolved' | 'artifact-missing-hash';
}

/** A subresource that violates the tier's closure requirement. */
export interface TierClosureIssue {
  readonly ref: CapsuleRef;
  readonly reason: 'non-public-subresource-in-public-tier';
}

/** The combined verdict. `ok` ⇒ publishable. */
export interface ClosureValidation {
  readonly ok: boolean;
  readonly referenceIssues: readonly ReferenceClosureIssue[];
  readonly tierIssues: readonly TierClosureIssue[];
}

/**
 * Default tier-publicness predicate (L083 sane default): the `'public'` tier
 * requires a fully-public closure; every other tier (e.g. `'gated'`) does not.
 * Callers may pass their own DATA-driven predicate to `validateTierClosure`.
 */
export function defaultTierIsPublic(tier: CapsuleTier): boolean {
  return tier === 'public';
}

/**
 * REFERENCE CLOSURE — fail on any unresolved ref or any artifact missing its hash.
 * `unresolved` is the set of refs the builder could not resolve at all.
 */
export function validateReferenceClosure(
  artifacts: readonly CapsuleArtifact[],
  unresolved: readonly CapsuleRef[],
): readonly ReferenceClosureIssue[] {
  const issues: ReferenceClosureIssue[] = [];
  for (const ref of unresolved) issues.push({ ref, reason: 'unresolved' });
  for (const artifact of artifacts) {
    if (!artifact.integrity_hash) {
      issues.push({ ref: artifact.ref, reason: 'artifact-missing-hash' });
    }
  }
  return issues;
}

/**
 * TIER CLOSURE — when the tier requires a public closure (`tierIsPublic(tier)`),
 * every artifact must be `public_readable`. Otherwise no tier issues.
 */
export function validateTierClosure(
  tier: CapsuleTier,
  artifacts: readonly CapsuleArtifact[],
  tierIsPublic: (tier: CapsuleTier) => boolean = defaultTierIsPublic,
): readonly TierClosureIssue[] {
  if (!tierIsPublic(tier)) return [];
  const issues: TierClosureIssue[] = [];
  for (const artifact of artifacts) {
    if (!artifact.public_readable) {
      issues.push({ ref: artifact.ref, reason: 'non-public-subresource-in-public-tier' });
    }
  }
  return issues;
}

/** Combine both gates into the publishable verdict. */
export function validateClosure(
  tier: CapsuleTier,
  artifacts: readonly CapsuleArtifact[],
  unresolved: readonly CapsuleRef[],
  tierIsPublic: (tier: CapsuleTier) => boolean = defaultTierIsPublic,
): ClosureValidation {
  const referenceIssues = validateReferenceClosure(artifacts, unresolved);
  const tierIssues = validateTierClosure(tier, artifacts, tierIsPublic);
  return { ok: referenceIssues.length === 0 && tierIssues.length === 0, referenceIssues, tierIssues };
}
