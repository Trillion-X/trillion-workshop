// Public edge for the media-bytes readers — the producer-blind "ordered chunk
// refs -> Blob" primitive across three transports (IndexedDB, guarded base64
// delivery, HTTP /cas/). Consumers import from this barrel, never a deep file.
export {
  isSelfDescribingChunkRef,
  readSelfDescribingChunkBlob,
  type SelfDescribingChunkRef,
} from './read-self-describing-chunk-blob';
export {
  chunkHashesFromManifest,
  assembleCasChunkManifestBlob,
  defaultCasFetch,
  type CasFetch,
  type CasChunkManifestRef,
} from './read-cas-chunk-manifest-blob';
