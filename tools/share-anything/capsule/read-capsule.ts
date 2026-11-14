// packages/public-scene-share/capsule/read-capsule.ts
//
// PURPOSE
// The render-side inverse of `closure-builder.ts`: decode capsule bytes into the
// `CapsuleRenderInput` a no-account viewer needs to reconstruct the scene WITHOUT
// any live engine. The T5 render shell consumes this; the cross-origin sandbox
// then fetches each artifact's bytes by hash and mounts them. This module is the
// PURE decode — zero I/O, zero infra — so the capsule's round-trip (mint → bytes →
// read → render input) is provable today, before any public origin exists.
//
// NON-NEGOTIABLE INVARIANTS (mirror scene-capsule.ts):
//   - BLIND to ref kind (L090): artifacts/data are indexed generically by
//     `refKey(kind,id)`. The reader NEVER branches on a ref's kind.
//   - SCENE-FORMAT AGNOSTIC (L098): `sceneSnapshot` and `frozenChrome` pass through
//     OPAQUE — the reader never parses them (the renderer's concern, not the
//     capsule's).
//   - FORWARD-COMPAT FAIL-CLOSED: an unknown `manifestVersion` or a malformed
//     artifact is REJECTED with a structured reason, never mis-rendered.

import {
  CAPSULE_MANIFEST_VERSION,
  refKey,
  type SceneCapsule,
} from './scene-capsule';

/**
 * What a capsule decodes to — exactly what the T5 render shell needs to rebuild the
 * scene offline. `sceneTree`/`chrome` are opaque (the renderer interprets them);
 * refs are resolved generically by `refKey`.
 */
export interface CapsuleRenderInput {
  readonly tier: string;
  /** Opaque frozen scene tree — handed to the renderer untouched. */
  readonly sceneTree: unknown;
  /** Opaque frozen ChromeVisibilityMap — handed to the renderer untouched. */
  readonly chrome: unknown;
  /** `refKey(kind,id)` → CAS integrity hash. The renderer fetches `/cas/<hash>`. */
  readonly artifactHashByRef: ReadonlyMap<string, string>;
  /** `refKey(kind,id)` → frozen query value. Injected as-is (no live re-query). */
  readonly dataByRef: ReadonlyMap<string, unknown>;
}

export type ReadCapsuleResult =
  | { readonly ok: true; readonly input: CapsuleRenderInput }
  | { readonly ok: false; readonly reason: string };

/** Decode raw capsule bytes (the `/c/<hash>` payload) into render input. */
export function readCapsuleBytes(
  bytes: Uint8Array,
  supportedVersions: readonly string[] = [CAPSULE_MANIFEST_VERSION],
): ReadCapsuleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return { ok: false, reason: `capsule bytes are not valid JSON: ${(error as Error).message}` };
  }
  return readCapsule(parsed, supportedVersions);
}

/** Decode an already-parsed capsule object into render input. */
export function readCapsule(
  value: unknown,
  supportedVersions: readonly string[] = [CAPSULE_MANIFEST_VERSION],
): ReadCapsuleResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'capsule is not an object' };
  }
  const cap = value as SceneCapsule;
  if (typeof cap.manifestVersion !== 'string' || !supportedVersions.includes(cap.manifestVersion)) {
    return { ok: false, reason: `unsupported manifest version: ${String(cap.manifestVersion)}` };
  }

  const artifactHashByRef = new Map<string, string>();
  for (const a of cap.artifacts ?? []) {
    if (!a?.ref || typeof a.integrity_hash !== 'string' || a.integrity_hash === '') {
      return { ok: false, reason: `artifact missing ref/integrity_hash: ${JSON.stringify(a)}` };
    }
    artifactHashByRef.set(refKey(a.ref), a.integrity_hash);
  }

  const dataByRef = new Map<string, unknown>();
  for (const d of cap.frozenData ?? []) {
    if (!d?.ref) return { ok: false, reason: `frozen data missing ref: ${JSON.stringify(d)}` };
    dataByRef.set(refKey(d.ref), d.value);
  }

  return {
    ok: true,
    input: {
      tier: cap.tier,
      sceneTree: cap.sceneSnapshot,
      chrome: cap.frozenChrome,
      artifactHashByRef,
      dataByRef,
    },
  };
}
