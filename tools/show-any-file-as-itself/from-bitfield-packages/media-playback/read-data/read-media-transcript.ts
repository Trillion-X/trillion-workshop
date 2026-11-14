import { readTranscriptSegments, type TranscriptSegment } from '../../../../transcript-reader/read-data/read-transcript-records.ts';
import type { MediaSourceRecord } from '../../../read-data/read-media-playback.ts';

/** Resolve timestamped words from the current transcript attached to a media record. */
export function readMediaTranscriptSegments(
  source: unknown,
  media: MediaSourceRecord | undefined,
): TranscriptSegment[] | undefined {
  if (!media?.transcript_ref) return undefined;
  // Published course transcripts are plain transcript-segment rows, not
  // screen-ready-record wrappers. Read those directly; older callers may still
  // provide the wrapped form handled below.
  const directRows = Array.isArray(source)
    ? source
    : source && typeof source === 'object' && Array.isArray((source as { records?: unknown }).records)
      ? (source as { records: unknown[] }).records
      : [];
  const directSegments = directRows.flatMap((row): TranscriptSegment[] => {
    if (!row || typeof row !== 'object') return [];
    const value = row as Record<string, unknown>;
    if (value.kind !== 'transcript-segment'
      || value.transcript_ref !== media.transcript_ref
      || typeof value.id !== 'string'
      || typeof value.text !== 'string') return [];
    return [value as TranscriptSegment];
  });
  if (directSegments.length) return directSegments.sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
  const segments = readTranscriptSegments(source, media.transcript_ref);
  return segments.length > 0 ? segments : undefined;
}
