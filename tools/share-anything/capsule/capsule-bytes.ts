// packages/public-scene-share/capsule/capsule-bytes.ts
//
// PURPOSE
// The content-addressing half of the capsule: turn a `SceneCapsule` into CANONICAL
// bytes whose hash IS the capsule's identity (and its URL path). Content-addressing
// only works if the SAME capsule always serializes to the SAME bytes — so this
// module is purely about determinism. It does NOT hash (the hash is the runtime's
// SSOT `makeHashCodeHexFromBytes`, applied at the do-work layer) and does NOT do
// I/O — keeping `capsule/` a zero-dependency pure leaf (L106).
//
// WHY CANONICAL JSON
// `JSON.stringify` preserves key INSERTION order, so two value-identical capsules
// built by different code paths would serialize to different bytes ⇒ different
// hashes ⇒ the same scene shared twice would mint two URLs. Canonical form sorts
// every object's keys recursively, so value-equality ⇒ byte-equality ⇒ hash-
// equality. (SP4: canonical sorted-key bytes are the signing/addressing substrate.)

import type { SceneCapsule } from './scene-capsule';

/** Recursively sort object keys so serialization depends only on VALUE, not order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize); // arrays: order is significant
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) sorted[key] = canonicalize(v); // omit undefined (not JSON anyway)
    }
    return sorted;
  }
  return value;
}

/** Deterministic UTF-8 JSON bytes of any JSON-serializable value (sorted keys). */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalize(value)));
}

/** The canonical bytes of a capsule — the substrate the content hash is taken over. */
export function canonicalCapsuleBytes(capsule: SceneCapsule): Uint8Array {
  return canonicalJsonBytes(capsule);
}

// ── URL minting (origin injected — infra-independent, T3 decides the origin) ──────

/** The public CDN tier path for a capsule by its content hash: `/c/<hash>`. */
export function capsuleContentPath(hash: string): string {
  return `/c/${encodeURIComponent(hash)}`;
}

/** The mutable shortlink path: `/s/<shortid>` (resolved by the registry, T4). */
export function capsuleShortPath(shortid: string): string {
  return `/s/${encodeURIComponent(shortid)}`;
}

/** Join an origin (e.g. `https://share.bitfield.so`) with a capsule path. */
export function capsuleUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}
