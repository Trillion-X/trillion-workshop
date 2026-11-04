// package-set://bitfield-studio/packages/record-audio/read-data/recording-enrichment.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The AI's finished read of a recording — a title, a subtitle, and a summary —
// published by the transcription owner as a self-describing
// `audio-transcription.enrichment` fact. This package never imports or names
// that package: it matches the `kind` string on the shared published-records
// feed and joins on `recorded_file_id` (L090 self-describing data, generic
// handler; L098 the producer hands back a finished fact in the consumer's
// language). The recording's own label/subtitle stay authoritative — this is a
// suggestion the person may accept, never an overwrite.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** One AI enrichment read, joined to the recording it describes. */
export type RecordingEnrichment = {
  recordedFileId: string;
  title: string;
  subtitle: string;
  summary: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Index every published `audio-transcription.enrichment` fact by the recording
 * it describes. There is one enrichment per recording (addressed by request id),
 * so a re-run simply replaces the prior fact in the feed and last-seen for an id
 * is the current read. Records without a `recorded_file_id`, and the explicit
 * `audio-transcription.enrichment-error` facts, are skipped — the consumer shows
 * a suggestion only when there is a real one to show.
 */
export function decodeEnrichmentsByRecording(
  publishedRecords: readonly { payload: unknown }[],
): Map<string, RecordingEnrichment> {
  const byRecording = new Map<string, RecordingEnrichment>();
  for (const record of publishedRecords) {
    if (!isPlainRecord(record.payload)) continue;
    const payload = record.payload;
    if (payload.kind !== 'audio-transcription.enrichment') continue;
    const recordedFileId = text(payload, 'recorded_file_id');
    if (!recordedFileId) continue;
    byRecording.set(recordedFileId, {
      recordedFileId,
      title: text(payload, 'title'),
      subtitle: text(payload, 'subtitle'),
      summary: text(payload, 'summary'),
    });
  }
  return byRecording;
}
