/**
 * #98 Auto-highlight / auto-shorts (Opus-Clip class). A PURE scorer over transcript+energy segments
 * that picks the top viral windows, plus a PURE authorer that turns those windows into `remove-span`
 * edit-decisions (the fold op the timeline already has) so the long recording is trimmed down to just
 * the highlights. NO new fold op and NO new render code (L069): a highlight is the complement of the
 * spans we remove. Serves L149 (produce hundreds of shorts/day from one long recording). Deterministic,
 * no I/O, so the scoring math is offline-unit-testable.
 */

/** One analyzed slice of the source: a transcript sentence/segment with a per-slice audio energy. */
import { rangeComplement } from './range-complement.mjs';

export interface HighlightSegment {
  start: number;
  end: number;
  text?: string;
  /** Normalized 0..1 loudness for this slice (from decoded peaks or ffmpeg RMS); may be omitted. */
  energy?: number;
}

/** A scored contiguous window worth keeping. */
export interface HighlightWindow {
  start: number;
  end: number;
  score: number;
}

export interface HighlightOptions {
  /** How many highlight windows to keep (default 1 = one short). */
  count?: number;
  /** Segments scoring below this 0..1 threshold are not seeds (default: the mean segment score). */
  minScore?: number;
  /** Words that, when present in a segment, raise its score (hooks, CTAs). Case-insensitive. */
  keywords?: string[];
}

const EMPHASIS = /[!?]/;

/** PURE per-segment score in 0..1: audio energy blended with a text signal (length + emphasis +
 *  keyword hits). Energy falls back to 0.5 when absent so a transcript-only source still ranks. */
export function scoreSegment(seg: HighlightSegment, keywords: string[]): number {
  const energy = Number.isFinite(seg.energy) ? Math.max(0, Math.min(1, seg.energy as number)) : 0.5;
  const text = typeof seg.text === 'string' ? seg.text : '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  // A complete-ish sentence (roughly 4..24 words) is more clippable than a fragment or a ramble.
  const lengthSignal = words === 0 ? 0 : Math.max(0, 1 - Math.abs(words - 12) / 12);
  const emphasis = EMPHASIS.test(text) ? 1 : 0;
  const lower = text.toLowerCase();
  const hits = keywords.reduce((n, k) => (k && lower.includes(k.toLowerCase()) ? n + 1 : n), 0);
  const keywordSignal = keywords.length ? Math.min(1, hits / Math.max(1, keywords.length)) : 0;
  const textSignal = 0.5 * lengthSignal + 0.25 * emphasis + 0.25 * keywordSignal;
  // Energy carries the moment; text carries the clippability. Blend, clamp to 0..1.
  return Math.max(0, Math.min(1, 0.6 * energy + 0.4 * textSignal));
}

/**
 * PURE. Score every segment, seed windows from runs of above-threshold segments, and return the top
 * `count` windows (by window score) sorted by start time. A window's score is its mean segment score
 * weighted by its duration, so a strong long moment beats a strong blip. Non-overlapping by construction
 * (windows come from disjoint segment runs).
 */
export function scoreHighlightWindows(
  segments: HighlightSegment[],
  opts: HighlightOptions = {},
): HighlightWindow[] {
  const clean = segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  if (clean.length === 0) return [];
  const keywords = Array.isArray(opts.keywords) ? opts.keywords : [];
  const scored = clean.map((s) => ({ seg: s, score: scoreSegment(s, keywords) }));
  const mean = scored.reduce((n, x) => n + x.score, 0) / scored.length;
  const threshold = Number.isFinite(opts.minScore) ? (opts.minScore as number) : mean;

  const windows: HighlightWindow[] = [];
  let run: Array<{ seg: HighlightSegment; score: number }> = [];
  const flush = () => {
    if (run.length === 0) return;
    const start = run[0].seg.start;
    const end = run[run.length - 1].seg.end;
    const meanScore = run.reduce((n, x) => n + x.score, 0) / run.length;
    windows.push({ start, end, score: Number((meanScore * (end - start)).toFixed(6)) });
    run = [];
  };
  for (const x of scored) {
    if (x.score >= threshold) run.push(x);
    else flush();
  }
  flush();

  const count = Number.isInteger(opts.count) && (opts.count as number) > 0 ? (opts.count as number) : 1;
  return windows
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => a.start - b.start);
}

/**
 * PURE. Turn the kept windows into the `remove-span` decisions that delete everything OUTSIDE them.
 * The removed spans are the complement gaps of the windows within [0, totalDuration]. They are authored
 * LAST-gap-first (start descending) so each ripple-left removal does not shift the coordinates of the
 * gaps still to be authored. Each decision is the exact DATA foldRemoveSpan consumes.
 */
export function highlightDecisions(
  windows: HighlightWindow[],
  args: { totalDuration: number; sourceRef: Record<string, unknown>; createdAt: string },
): Array<{ action: 'remove-span'; label: string; source_ref: Record<string, unknown>; created_at: string; parameters: { start: number; end: number } }> {
  const total = args.totalDuration;
  if (!Number.isFinite(total) || total <= 0) return [];
  const kept = windows
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .map((w) => ({ start: Math.max(0, w.start), end: Math.min(total, w.end) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  if (kept.length === 0) return [];

  const gaps: Array<{ start: number; end: number }> = rangeComplement(kept, total);

  return gaps
    .filter((g) => g.end - g.start > 1e-6)
    .sort((a, b) => b.start - a.start) // last gap first: ripple-left removals keep earlier gaps valid
    .map((g) => ({
      action: 'remove-span' as const,
      label: `Trim to highlight ${g.start.toFixed(2)}s`,
      source_ref: args.sourceRef,
      created_at: args.createdAt,
      parameters: { start: Number(g.start.toFixed(3)), end: Number(g.end.toFixed(3)) },
    }));
}
