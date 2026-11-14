# media-bytes

Generic, producer-blind readers that resolve a self-describing bytes reference into playable browser bytes (a `Blob`/object URL) without importing the package that produced it.

## Files

| File | Purpose |
|------|---------|
| `read-self-describing-chunk-blob.ts` | Resolve an IndexedDB-backed ordered-chunk ref (`{database, store, chunk_refs, media_type}`) to a `Blob`. |
| `read-self-describing-chunk-blob.test.ts` | Tests for the IndexedDB chunk reader. |
| `read-guarded-artifact-blob.ts` | Decode a guarded base64 artifact delivery (≤16MB) — from a `content-media-evidence.read-guarded-artifact` decision — to a verified `Blob`/object URL. |
| `read-guarded-artifact-blob.test.ts` | Tests for the guarded-artifact decoder. |
| `read-cas-chunk-manifest-blob.ts` | Resolve an engine `/cas/` artifact stored as an ordered chunk manifest (multichunk) or a single whole object to a `Blob`. The `/cas/` route returns raw bytes per hash and does NOT reassemble — this reader fetches the manifest, parses ordered chunk hashes, fetches each, and concatenates client-side. |
| `read-cas-chunk-manifest-blob.test.ts` | Tests for the `/cas/` chunk-manifest reader (manifest shapes, single/multichunk, empty-ref error). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `SelfDescribingChunkRef` | `{ database, store, chunk_refs: {key}[], media_type? }` | IndexedDB ordered-chunk ref. |
| `readSelfDescribingChunkBlob(ref)` | `(ref) => Promise<Blob \| null>` | IndexedDB transport → Blob (null if any chunk missing). |
| `GuardedArtifactDelivery` | `{ bytes_base64, byte_length, integrity_hash, media_type, display_name, decision_ref }` | Guarded base64 delivery payload. |
| `decodeGuardedArtifactDelivery(value)` | `(value) => GuardedArtifactDelivery & {bytes}` | Validate + decode guarded artifact bytes. |
| `CasChunkManifestRef` | `{ manifestHash?, wholeObjectHash?, mediaType? }` | HTTP `/cas/` ordered-chunk ref (media type is caller-supplied — no format hardcoded). |
| `CasFetch` | `(hash) => Promise<ArrayBuffer>` | Injected `/cas/<hash>` byte fetcher (defaults to same-origin). |
| `chunkHashesFromManifest(manifest)` | `(unknown) => string[]` | Pure: ordered chunk hashes from `[hash]` / `{chunks:[{content_hash\|hash\|address}]}` / `{entries}`. |
| `assembleCasChunkManifestBlob(ref, fetchCas?)` | `(ref, fetchCas?) => Promise<Blob>` | HTTP `/cas/` transport → Blob (single whole object or reassembled multichunk). |

All three readers are configurations of one primitive — **ordered chunk refs → Blob** — differing only in transport (IndexedDB, guarded base64 delivery, HTTP `/cas/`). None names what it reads (L090); none imports a producing package.

## Dependencies

**Depends on:** `@bitfield/runtime-kit/protocol` (`makeHashCodeHexFromBytes`, guarded-artifact integrity verification only); browser `indexedDB` / `fetch` / `Blob` / `URL`.

**Depended on by:** any surface that must play produced bytes from a ref — e.g. `motion-comparison` (`read-data/render-video.ts` → `assembleCasChunkManifestBlob` for the side-by-side render mp4). Consumers import each reader by direct file path (no barrel).
