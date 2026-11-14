// Resolve a motion-comparison render record to a playable video URL for the
// Side-by-Side surface. The rendered side-by-side mp4 is an engine /cas/ artifact:
// a SINGLE-chunk render is served directly at /cas/<integrityHash>; a MULTICHUNK
// render is reassembled client-side via the shared generic reader (the /cas/ route
// returns raw bytes per hash and does NOT reassemble).
//
// The generic HTTP-/cas/-multichunk primitive lives in the shared ui media-bytes
// layer (read-cas-chunk-manifest-blob.ts) beside its IndexedDB and guarded-artifact
// siblings — this file holds ONLY the motion-comparison-specific mapping from a
// MotionComparisonRenderRecord to that generic call, plus the React hook.
import * as React from 'react';
import {
  assembleCasChunkManifestBlob,
  type CasFetch,
} from '@/packages/ui/show/media-bytes';
import type { MotionComparisonRenderRecord } from './motion-comparison-factor-types.ts';

const VIDEO_MIME = 'video/mp4';

/** React hook: a render record → a playable video URL. Single-chunk resolves to a
 *  direct /cas/<integrityHash> URL (no fetch); multichunk reassembles to an object
 *  URL (revoked on cleanup). Returns undefined while loading or when unresolvable. */
export function useRenderVideoUrl(
  render: MotionComparisonRenderRecord | undefined,
  fetchCas?: CasFetch,
): string | undefined {
  const [url, setUrl] = React.useState<string | undefined>(undefined);
  const manifestHash = render?.renderMp4ChunkManifestHash;
  const integrityHash = render?.renderMp4IntegrityHash;
  React.useEffect(() => {
    if (!render) {
      setUrl(undefined);
      return;
    }
    // Single-chunk: the integrity hash IS the whole-object CAS address — serve directly.
    if (!manifestHash && integrityHash) {
      setUrl(`/cas/${integrityHash}?mime=${VIDEO_MIME}`);
      return;
    }
    if (!manifestHash) {
      setUrl(undefined);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    assembleCasChunkManifestBlob(
      { manifestHash, wholeObjectHash: integrityHash, mediaType: VIDEO_MIME },
      fetchCas,
    )
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(undefined);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [render, manifestHash, integrityHash, fetchCas]);
  return url;
}
