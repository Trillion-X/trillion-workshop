/**
 * Beat-synced cuts: turn a detected beat-time list (from motion-analysis audio.beat.track,
 * `beat_track.v1`) into timeline SPLIT points so clip boundaries land on the music. The cut
 * itself reuses the existing `split` fold primitive (one split decision per chosen beat); this
 * module is the pure DATA transform that chooses WHICH beats become cuts. No render code: a
 * beat-cut is just a hard-cut boundary the compositor already concatenates.
 *
 * L069: the beat list is DATA a producer writes; this transform is blind to genre/instrument.
 * everyNth downsamples the grid (cut on every beat, every other, every bar of 4, etc.) with zero
 * new code; a totally different beat set (spoken-word stresses, footsteps, ball bounces) drives
 * it identically.
 */

export type BeatSyncOptions = {
  /** Only cut at beats within [start, end) of the composition timeline. */
  start?: number;
  end?: number;
  /** Keep every Nth beat (1 = every beat, 2 = every other, 4 = downbeat of a 4/4 bar). */
  everyNth?: number;
  /** Drop cuts closer than this many seconds to the previous kept cut (avoid micro-clips). */
  minGap?: number;
  /** Phase offset into the everyNth window (0 = first beat, 1 = second, ...). */
  phase?: number;
};

/**
 * Choose the split times from a beat list. Returns ascending, de-duplicated times strictly
 * inside (start, end) so the first/last frame is never a zero-length split.
 */
export function beatSyncSplitTimes(beats: number[], opts: BeatSyncOptions = {}): number[] {
  const start = Number.isFinite(opts.start) ? (opts.start as number) : -Infinity;
  const end = Number.isFinite(opts.end) ? (opts.end as number) : Infinity;
  const everyNth = Math.max(1, Math.floor(opts.everyNth ?? 1));
  const phase = ((Math.floor(opts.phase ?? 0) % everyNth) + everyNth) % everyNth;
  const minGap = Number.isFinite(opts.minGap) ? Math.max(0, opts.minGap as number) : 0;

  const sorted = [...beats].filter((b) => Number.isFinite(b)).sort((a, b) => a - b);
  const out: number[] = [];
  let kept = -Infinity;
  sorted.forEach((t, i) => {
    if (i % everyNth !== phase) return;
    if (!(t > start && t < end)) return;
    if (out.length && Math.abs(t - out[out.length - 1]) < 1e-6) return; // dedupe
    if (t - kept < minGap) return;
    out.push(t);
    kept = t;
  });
  return out;
}

/**
 * Materialize beat cuts as `split` edit decisions (author order does not matter for split:
 * each split acts on whatever clip currently spans that time). laneRole scopes the cuts to one
 * lane when provided.
 */
export function beatSyncSplitDecisions(
  beats: number[],
  opts: BeatSyncOptions & { laneRole?: string; sourceRef?: unknown; createdAt?: string } = {},
): Array<{ action: 'split'; parameters: Record<string, unknown>; span: Record<string, unknown>; source_ref: unknown; created_at: string; label: string }> {
  const createdAt = opts.createdAt ?? '1970-01-01T00:00:00.000Z';
  return beatSyncSplitTimes(beats, opts).map((time) => ({
    action: 'split' as const,
    label: 'split',
    span: {},
    source_ref: opts.sourceRef ?? {},
    created_at: createdAt,
    parameters: opts.laneRole ? { time, lane_role: opts.laneRole } : { time },
  }));
}
