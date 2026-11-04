// package-set://bitfield-studio/packages/media-composition/read-data/auto-cleanup.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Descript-class auto-cleanup: read the timed transcript words and emit the SPANS
// that should be cut, so the caller authors them as `remove-span` edit-decisions
// (the SAME atomic fold the transcript editor uses, so cleanup renders for free via
// compose-timeline -> materialize-edl -> video-compose). Two removal reasons, both
// DATA-configured, both the SAME span primitive (L069):
//
//   - SILENCE: a gap between consecutive words longer than `minSilence` becomes a
//     removable span, keeping `silencePad` of breathing room at each edge.
//   - FILLER: a word whose normalized token is in the `fillers` set (DATA, never a
//     closed enum in engine code) becomes a removable span over its own [start,end].
//
// NON-NEGOTIABLE INVARIANTS
//   1. PURE & DETERMINISTIC: no I/O, no Date.now(). Input is the already-read words.
//   2. FILLER SET IS DATA: passed in `opts.fillers`; a default list is a convenience
//      default value, never a hardcoded branch. Adding a filler is a DATA edit.
//   3. SPANS ARE MERGED + SORTED so overlapping silence/filler cuts never double-remove.
//   4. AUTHOR-ORDER HELPER returns spans DESCENDING by start, because each remove-span
//      fold ripples later footage left; cutting right-to-left keeps every earlier span's
//      coordinates valid without recomputing shifts.
// =============================================================================

/** One timed transcript token (timeline seconds). Matches read-transcript-words. */
export type TranscriptWord = { text: string; start: number; end: number };

export type CleanupSpan = { start: number; end: number; reason: 'silence' | 'filler' };

export type CleanupOptions = {
  /** Gap (seconds) between words that counts as removable silence. */
  minSilence?: number;
  /** Breathing room (seconds) kept at each edge of a removed silence. */
  silencePad?: number;
  /** Filler tokens to strip (DATA). A default list is provided when omitted. */
  fillers?: string[];
  removeSilence?: boolean;
  removeFillers?: boolean;
};

/** Convenience default filler set (DATA default, not a code branch). */
export const DEFAULT_FILLERS: string[] = [
  'um', 'umm', 'uh', 'uhh', 'er', 'err', 'ah', 'ahh', 'hmm', 'mmm',
  'like', 'basically', 'literally', 'actually', 'so', 'yeah',
];

/** Normalize a token for filler matching: lowercase, strip surrounding punctuation. */
function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/** Merge overlapping or touching spans (sorted ascending). Preserves the first reason. */
function mergeSpans(spans: CleanupSpan[]): CleanupSpan[] {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const merged: CleanupSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 1e-6) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Detect the spans to cut from a word list. Silence and filler detection are
 * independent DATA toggles; the results are merged so a filler inside a silence
 * gap is never counted twice.
 */
export function detectCleanupSpans(words: TranscriptWord[], opts: CleanupOptions = {}): CleanupSpan[] {
  const minSilence = opts.minSilence ?? 0.6;
  const pad = Math.max(0, opts.silencePad ?? 0.1);
  const fillers = new Set((opts.fillers ?? DEFAULT_FILLERS).map((f) => normalizeToken(f)));
  const removeSilence = opts.removeSilence ?? true;
  const removeFillers = opts.removeFillers ?? true;

  const ordered = [...words].filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .sort((a, b) => a.start - b.start);
  const spans: CleanupSpan[] = [];

  if (removeSilence) {
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const gap = ordered[i + 1].start - ordered[i].end;
      if (gap > minSilence) {
        const start = ordered[i].end + pad;
        const end = ordered[i + 1].start - pad;
        if (end > start) spans.push({ start, end, reason: 'silence' });
      }
    }
  }

  if (removeFillers) {
    for (const w of ordered) {
      if (fillers.has(normalizeToken(w.text))) spans.push({ start: w.start, end: w.end, reason: 'filler' });
    }
  }

  return mergeSpans(spans);
}

/**
 * Spans in author order: DESCENDING by start. Each remove-span fold ripples later
 * footage left, so authoring right-to-left keeps every earlier span's coordinates
 * valid (no cumulative-shift math).
 */
export function cleanupSpansInAuthorOrder(spans: CleanupSpan[]): CleanupSpan[] {
  return [...spans].sort((a, b) => b.start - a.start);
}
