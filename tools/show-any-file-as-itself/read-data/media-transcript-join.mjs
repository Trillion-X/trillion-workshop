// tools/show-any-file-as-itself/read-data/media-transcript-join.mjs
//
// The timestamped words of one media item, read from the published transcript-segment rows that carry its
// transcript_ref. Ported from bitfield-packages packages/media-playback read-data/read-media-transcript.ts (83a16bc292),
// the direct-row branch. The old fallback read the wrapped transcript form through a reader package; here that
// reader is passed in (readWrapped), so this file does not reach into another tool.
//
// Invariants (kept from the old file):
// - A media item without a transcript_ref has no transcript (undefined, not an empty list).
// - Only segments whose transcript_ref is this item's ref are read: another item's transcript is never borrowed.
// - Segments come back in start order.

export function readMediaTranscriptSegments(source, media, { readWrapped } = {}) {
  if (!media?.transcript_ref) return undefined;
  const rows = Array.isArray(source)
    ? source
    : Array.isArray(source?.records) ? source.records : [];
  const direct = rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    if (row.kind !== 'transcript-segment' || row.transcript_ref !== media.transcript_ref
      || typeof row.id !== 'string' || typeof row.text !== 'string') return [];
    return [row];
  });
  if (direct.length) return direct.sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
  const wrapped = readWrapped ? readWrapped(source, media.transcript_ref) : [];
  return wrapped.length > 0 ? wrapped : undefined;
}
