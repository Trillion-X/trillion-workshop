/**
 * artifact-store.mjs — ARTIFACT-ONCE-BY-HASH primitive (WS3b-T4, pure leaf, no I/O, no main()).
 *
 * ROOT (WS3b-cas-growth-byte-attribution §<no-kind> anatomy): the SAME full artifact text (an entire
 * offer/article/ebook) was written INLINE into 3-4 different wrapper envelopes (agent-decision.decision_text,
 * action-intent-receipt.artifact, the producer result item, ai-memory-record.content). Each wrapper is a
 * DIFFERENT JSON object, so it hashes to a DIFFERENT CAS address — CAS whole-object dedup cannot collapse
 * them. Measured: 6,803 artifact texts -> only 660 DISTINCT -> ~90% of artifact bytes are duplicate copies.
 *
 * FIX (P5/P6 + SSOT applied to artifact text): the full artifact is stored ONCE at a CONTENT-ADDRESSED
 * address `package::autonomous-agent-tick::artifact::<hash>`. Because the address is derived from the content
 * hash and written via `identity_text`, two identical artifacts resolve to the SAME address and are stored
 * once by construction. Every wrapper carries a small `artifact_ref` (the store address + hash + char count
 * + a bounded preview for list rendering) instead of the full text. N inline copies -> 1 blob + N tiny refs.
 *
 * Retention (WS3b-T4-retention-data-spec): the `artifact-blob` kind is the canonical SSOT copy -> `durable`.
 * The wrapper kinds that used to inline the text drop to `history(N)` / `expiring` because their bytes are
 * now tiny (ref + preview), and the duplicate full-text mass is gone.
 *
 * Pure leaf: only `node:crypto`. No fetch, no fs, no process entry. Imported by the operator process files
 * AND their tests (one SSOT, L043 no-duplication).
 */
import { createHash } from 'node:crypto';

export const ARTIFACT_STORE_PREFIX = 'package::autonomous-agent-tick::artifact::';
export const ARTIFACT_STORE_INDEX = 'artifact-store-index';
export const PREVIEW_CHARS = 240;

/** Stable 32-hex content hash of an artifact text (sha256, truncated — collision-safe for this corpus). */
export function artifactHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/** The content-addressed store address for a given artifact text. Identical text -> identical address. */
export function artifactStoreAddress(text) {
  return ARTIFACT_STORE_PREFIX + artifactHash(text);
}

/**
 * The small reference a wrapper record carries INSTEAD of the full artifact text. `preview` is a bounded
 * slice so list/board surfaces render without resolving; the full text is fetched on demand from
 * `store_address`. `source_run` records the run that first produced it (provenance, not identity).
 */
export function buildArtifactRef(text, sourceRun) {
  const t = String(text ?? '');
  const hash = artifactHash(t);
  return {
    store_address: ARTIFACT_STORE_PREFIX + hash,
    artifact_hash: hash,
    artifact_chars: t.length,
    preview: t.slice(0, PREVIEW_CHARS),
    source_run: sourceRun == null ? null : String(sourceRun),
  };
}

/**
 * The write-batch entry that stores the canonical artifact ONCE. Idempotent: same text -> same address, so
 * re-writing is a no-op rewrite (zero durable delta once WS3b-T3 delta-accounting lands). `path_labels`
 * puts it on a DEDICATED list so readers of the store never scan `published-record` (L126).
 */
export function buildArtifactBlobWrite(text, sourceRun, partitionLabel) {
  const t = String(text ?? '');
  const hash = artifactHash(t);
  return {
    partition_label: partitionLabel,
    address_label: ARTIFACT_STORE_PREFIX + hash,
    address_mode: 'identity_text',
    path_labels: ['current-item', ARTIFACT_STORE_INDEX],
    payload: {
      kind: 'artifact-blob',
      id: ARTIFACT_STORE_PREFIX + hash,
      artifact_hash: hash,
      text: t,
      artifact_chars: t.length,
      first_source_run: sourceRun == null ? null : String(sourceRun),
    },
  };
}

/** True when a resolved blob payload's text matches the ref's hash (fail-closed integrity check). */
export function refMatchesText(ref, text) {
  return !!ref && typeof ref.artifact_hash === 'string' && ref.artifact_hash === artifactHash(text);
}

/**
 * Resolve the full artifact text from a stored blob payload obtained by reading `ref.store_address`.
 * Returns the text ONLY when the hash verifies; otherwise null (fail-closed — a caller that needs the full
 * text to dispatch must skip rather than send wrong bytes).
 */
export function extractResolvedArtifact(ref, blobPayload) {
  const text = blobPayload && typeof blobPayload.text === 'string' ? blobPayload.text : null;
  if (text == null) return null;
  return refMatchesText(ref, text) ? text : null;
}
