import { readScreenReadyRecords } from '../../screen-ready-records/read-data/read-screen-ready-records';

export type PublishedRecord = unknown;

export type TranscriptEntry = {
  content_ref?: string;
  id: string;
  label?: string;
  media_ref?: string;
};

export type TranscriptSegment = {
  confidence?: number;
  end_ms?: number;
  id: string;
  is_emphasis?: boolean;
  language?: string;
  loudness?: number;
  speaker?: string;
  start_ms?: number;
  text: string;
  transcript_ref: string;
  words?: TranscriptWord[];
};

export type TranscriptWord = {
  confidence?: number;
  end: number;
  loudness?: number;
  start: number;
  word: string;
};

export type TranscriptData = {
  entries: TranscriptEntry[];
  segments: TranscriptSegment[];
};

/** Distinct, named speakers in the order they first appear in this transcript. */
export function transcriptSpeakers(segments: readonly { speaker?: string }[]): string[] {
  const seen = new Set<string>();
  for (const segment of segments) {
    const speaker = segment.speaker?.trim();
    if (speaker) seen.add(speaker);
  }
  return [...seen];
}

/** Keep every passage, or only passages assigned to the selected speaker. */
export function transcriptSegmentsForSpeaker<Segment extends { speaker?: string }>(
  segments: readonly Segment[],
  speaker: string | null,
): Segment[] {
  if (speaker === null) return [...segments];
  return segments.filter((segment) => segment.speaker?.trim() === speaker);
}

export type TranscriptSemanticMatch = {
  /** Segment ids in the order returned by the generic meaning-search owner. */
  segment_id: string;
};

/**
 * Compose lexical transcript matches with an already-authorized semantic
 * result list. Reciprocal-rank fusion keeps both owners' ordering useful while
 * deduplicating segments that match both. This function does not create or
 * query an embedding index; callers supply results from meaning-search.
 */
export function rankTranscriptSearchResults(
  segments: readonly TranscriptSegment[],
  query: string,
  semanticMatches: readonly TranscriptSemanticMatch[] = [],
): TranscriptSegment[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...segments];

  const lexical = segments
    .map((segment, sourceIndex) => ({ segment, sourceIndex }))
    .filter((row) => row.segment.text.toLocaleLowerCase().includes(normalizedQuery));
  const semanticIds = [...new Set(semanticMatches.map((match) => match.segment_id))];
  const semanticRanks = new Map(semanticIds.map((id, index) => [id, index + 1]));
  const lexicalRanks = new Map(lexical.map((row, index) => [row.segment.id, index + 1]));
  const sourceIndexes = new Map(segments.map((segment, index) => [segment.id, index]));
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const candidateIds = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()]);
  const rankConstant = 60;

  return [...candidateIds]
    .filter((id) => byId.has(id))
    .sort((left, right) => {
      const leftScore = (lexicalRanks.has(left) ? 1 / (rankConstant + lexicalRanks.get(left)!) : 0)
        + (semanticRanks.has(left) ? 1 / (rankConstant + semanticRanks.get(left)!) : 0);
      const rightScore = (lexicalRanks.has(right) ? 1 / (rankConstant + lexicalRanks.get(right)!) : 0)
        + (semanticRanks.has(right) ? 1 / (rankConstant + semanticRanks.get(right)!) : 0);
      return rightScore - leftScore || sourceIndexes.get(left)! - sourceIndexes.get(right)!;
    })
    .map((id) => byId.get(id)!);
}

export type TranscriptSource = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readWords(value: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const words = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const word = readString(item.word);
    const start = readNumber(item.start);
    const end = readNumber(item.end);
    if (!word || start === undefined || end === undefined) return [];
    return [{
      confidence: readNumber(item.confidence),
      end,
      loudness: readNumber(item.loudness),
      start,
      word,
    }];
  });
  return words.length > 0 ? words : undefined;
}

function byStart(left: TranscriptSegment, right: TranscriptSegment) {
  return (left.start_ms ?? 0) - (right.start_ms ?? 0) || left.id.localeCompare(right.id);
}

function byLabel<T extends { id: string; label?: string }>(left: T, right: T) {
  return String(left.label ?? left.id).localeCompare(String(right.label ?? right.id));
}

export function readTranscriptData(source: TranscriptSource): TranscriptData {
  const rows = readScreenReadyRecords(source);
  const entries = (rows.recordsByRole['transcript-entry'] ?? []).flatMap((row) => {
    if (!isRecord(row.payload)) return [];
    const id = readString(row.payload.id) ?? row.record_ref ?? row.id;
    return [{
      content_ref: readString(row.payload.content_ref),
      id,
      label: readString(row.payload.label),
      media_ref: readString(row.payload.media_ref),
    }];
  });
  const segments = (rows.recordsByRole['transcript-segment'] ?? []).flatMap((row) => {
    if (!isRecord(row.payload)) return [];
    const id = readString(row.payload.id) ?? row.record_ref ?? row.id;
    const transcriptRef = readString(row.payload.transcript_ref);
    const text = readString(row.payload.text);
    if (!transcriptRef || !text) return [];
    return [{
      confidence: readNumber(row.payload.confidence),
      end_ms: readNumber(row.payload.end_ms),
      id,
      is_emphasis: readBoolean(row.payload.is_emphasis),
      language: readString(row.payload.language),
      loudness: readNumber(row.payload.loudness),
      speaker: readString(row.payload.speaker),
      start_ms: readNumber(row.payload.start_ms),
      text,
      transcript_ref: transcriptRef,
      words: readWords(row.payload.words),
    }];
  });

  return {
    entries: entries.sort(byLabel),
    segments: segments.sort(byStart),
  };
}

export function readTranscriptSegments(
  source: TranscriptSource,
  transcriptRef: string,
): TranscriptSegment[] {
  return readTranscriptData(source).segments.filter((segment) => segment.transcript_ref === transcriptRef);
}
