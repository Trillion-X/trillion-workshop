/**
 * file: packages/ui/show/media-bytes/read-cas-chunk-manifest-blob.ts
 *
 * PURPOSE: Generic reader for engine-served /cas/ artifacts that are stored as an
 * ORDERED chunk manifest (L090). The engine's /cas/<hash> route returns the raw
 * bytes AT that hash and does NOT reassemble — a large artifact is a JSON manifest
 * (at `manifestHash`) listing ordered chunk content hashes that must be fetched
 * and concatenated client-side. A small artifact is a single whole object at its
 * integrity hash. This reader resolves either shape to a playable Blob.
 *
 * Sibling of read-self-describing-chunk-blob.ts (IndexedDB transport) and
 * read-guarded-artifact-blob.ts (guarded base64 delivery). Same primitive —
 * "ordered chunk refs -> Blob" — over the HTTP /cas/ transport.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Zero producing-package imports — the manifest/hash data is the only contract.
 * 2. Zero Society vocabulary — this reader never names WHAT it reads. The media
 *    type is a caller-supplied parameter; it hardcodes no format.
 * 3. Read-only: fetches bytes, never writes.
 */

/** Fetch the raw bytes at a single /cas/ hash. Injected so tests/servers vary it. */
export type CasFetch = (hash: string) => Promise<ArrayBuffer>;

export type CasChunkManifestRef = {
  /** Hash of the ordered-chunk JSON manifest (multichunk artifacts). */
  manifestHash?: string;
  /** Hash of the whole object (single-chunk artifacts — the servable address). */
  wholeObjectHash?: string;
  /** Blob media type, e.g. 'video/mp4'. Caller-supplied — no format is hardcoded. */
  mediaType?: string;
};

/** Pure: extract the ordered chunk content hashes from a parsed manifest JSON.
 *  Accepts `[hash, ...]`, `{chunks:[{content_hash|hash|address}]}`, or `{entries:[...]}`. */
export function chunkHashesFromManifest(manifest: unknown): string[] {
  const source: unknown = Array.isArray(manifest)
    ? manifest
    : manifest && typeof manifest === 'object'
      ? (manifest as Record<string, unknown>).chunks ?? (manifest as Record<string, unknown>).entries ?? []
      : [];
  if (!Array.isArray(source)) return [];
  return source
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        return String(record.content_hash ?? record.hash ?? record.address ?? '');
      }
      return '';
    })
    .filter((hash) => hash.length > 0);
}

/** Same-origin /cas/<hash> fetch (the browser default transport). */
export async function defaultCasFetch(hash: string): Promise<ArrayBuffer> {
  const response = await fetch(`/cas/${hash}`);
  if (!response.ok) throw new Error(`/cas/${hash} -> ${response.status}`);
  return response.arrayBuffer();
}

/** Resolve an ordered-chunk /cas/ ref to a playable Blob. A single-chunk ref
 *  (no manifest) is the whole object at its integrity hash; a multichunk ref is
 *  the manifest fetched, parsed, and its ordered chunks fetched and concatenated. */
export async function assembleCasChunkManifestBlob(
  ref: CasChunkManifestRef,
  fetchCas: CasFetch = defaultCasFetch,
): Promise<Blob> {
  let chunkHashes: string[];
  if (ref.manifestHash) {
    const manifestBytes = new Uint8Array(await fetchCas(ref.manifestHash));
    let manifest: unknown = null;
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
      manifest = null;
    }
    chunkHashes = chunkHashesFromManifest(manifest);
  } else if (ref.wholeObjectHash) {
    chunkHashes = [ref.wholeObjectHash];
  } else {
    chunkHashes = [];
  }
  if (chunkHashes.length === 0) throw new Error('cas chunk-manifest ref has no resolvable chunks');
  const parts: BlobPart[] = [];
  for (const hash of chunkHashes) parts.push(new Uint8Array(await fetchCas(hash)));
  return new Blob(parts, ref.mediaType ? { type: ref.mediaType } : undefined);
}
