// packages/media-composition/read-data/read-transcript-words.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure reader: pull the frame-addressed WORD stream for the transcript-editing
// modality out of the media workspace, mapping raw producer keys through the
// modality's DATA field map. This is the substrate the transcript pane renders
// and selects over — deleting a sentence in the transcript is a `remove-span`
// over the `[start,end]` of the selected words.
//
// The reader is BLIND to the producer. It is handed an `EditModalitySource`
// (the `edit-modality` row's `source`: `{record_kind, word_kind, fields}`) and
// uses ONLY those DATA-declared keys — never a literal 't' / 'start' baked in.
// Swap audio-transcription for any other word producer by changing the DATA
// row's field map; this code is untouched (L090).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
//   1. PURE & DETERMINISTIC — no Date.now(), no I/O. Same view + source ⇒ same
//      words. Sorted by start; the surface never re-sorts.
//   2. FIELD NAMES ARE DATA — `fields.text/start/end` drive extraction. The
//      only literal fallback is the audio-transcription convention, used only
//      when the source omits a field map.
//   3. HONEST EMPTY — absent transcript ⇒ `[]`. The pane shows an empty state
//      and offers other modalities; it never fabricates words (L117).
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { MediaWorkspaceView } from '@/packages/media-composition/read-data/read-media-workspace';
import type { EditModalitySource } from '@/packages/media-composition/read-data/edit-capabilities';

/** One editable transcript word, in seconds, ready for the pane + `remove-span`. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  /** Position in the ordered stream (stable key + range selection). */
  index: number;
}

const DEFAULT_FIELDS = { text: 't', start: 'start', end: 'end' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Collect every workspace item whose record kind matches the modality source. */
function matchingPayloads(view: MediaWorkspaceView, recordKind: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();
  const consider = (kind: string | undefined, payload: unknown) => {
    if (kind !== recordKind || !isRecord(payload) || seen.has(payload)) return;
    seen.add(payload);
    out.push(payload);
  };
  for (const group of view.detailGroups) {
    for (const item of group.items) consider(item.record_kind, item.payload);
  }
  for (const lane of view.lanes) {
    for (const item of lane.items) consider(item.record_kind, item.payload);
  }
  return out;
}

/**
 * Read the ordered transcript word stream for the transcript modality. Returns
 * `[]` when no matching transcript record is present (honest empty state).
 *
 * @param view    the materialized media workspace.
 * @param source  the modality's DATA source descriptor (record_kind + fields).
 */
export function readTranscriptWords(
  view: MediaWorkspaceView,
  source: EditModalitySource,
): TranscriptWord[] {
  const recordKind = source.record_kind;
  if (!recordKind) return [];

  const textKey = source.fields?.text ?? DEFAULT_FIELDS.text;
  const startKey = source.fields?.start ?? DEFAULT_FIELDS.start;
  const endKey = source.fields?.end ?? DEFAULT_FIELDS.end;

  const raw: { text: string; start: number; end: number }[] = [];
  for (const payload of matchingPayloads(view, recordKind)) {
    const words = payload['words'];
    if (!Array.isArray(words)) continue;
    for (const entry of words) {
      if (!isRecord(entry)) continue;
      const start = asNumber(entry[startKey]);
      const end = asNumber(entry[endKey]);
      if (start === undefined || end === undefined) continue;
      const token = entry[textKey];
      raw.push({ text: typeof token === 'string' ? token : '', start, end });
    }
  }

  return raw
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((word, index) => ({ ...word, index }));
}
