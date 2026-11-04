// packages/group/do-work/frequency-tally.ts
//
// FREQUENCY TALLY — the generative primitive behind "show my tags/words by how OFTEN they appear" (the
// tag-cloud / word-cloud canon: the biggest chip is the most-used label). The requests "tag cloud / word
// cloud / top tags / size chips by count / kind breakdown" are all ONE computation configured by WHAT you
// count (an injected value extractor) and HOW count maps to size (the `scale`). Two pure steps:
//   • `frequencyTally(values)` — count occurrences into a Map (insertion-order preserved for stable rank ties).
//   • `frequencyScale(count, …)` — map a count to a font/size in [minSize, maxSize] via a DATA `scale`
//     (linear / sqrt / log — sqrt/log compress a long tail so one runaway tag never dwarfs the rest).
//
// Pure leaf — zero imports, deterministic, zero I/O. The show/ cloud injects `valuesOf` + renders sized chips;
// the value-source + scale catalogs live there as DATA (a new source/scale is one row, L090).

export type FrequencyScaleKind = 'linear' | 'sqrt' | 'log';

/** Count occurrences of each value. Insertion order preserved (stable tie-break for ranking + rendering). */
export function frequencyTally(values: Iterable<string>): Map<string, number> {
  const tally = new Map<string, number>();
  for (const v of values) {
    if (typeof v !== 'string' || v === '') continue;
    tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  return tally;
}

export interface RankedValue {
  readonly value: string;
  readonly count: number;
}

/** Tally → array sorted by count DESC, then first-seen order (stable). A `limit` keeps the top-N. Deterministic. */
export function tallyToRanked(tally: ReadonlyMap<string, number>, opts: { readonly limit?: number } = {}): RankedValue[] {
  // Map iteration is insertion order; index it so ties keep first-seen order after a stable-ish sort.
  const order = new Map<string, number>();
  let i = 0;
  for (const k of tally.keys()) order.set(k, i++);
  const ranked = [...tally.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || order.get(a.value)! - order.get(b.value)!);
  return typeof opts.limit === 'number' ? ranked.slice(0, Math.max(0, opts.limit)) : ranked;
}

export interface FrequencyScaleOptions {
  readonly minCount: number;
  readonly maxCount: number;
  /** Output size range (defaults 12..40). */
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly scale?: FrequencyScaleKind;
}

const transform = (v: number, kind: FrequencyScaleKind): number => {
  if (kind === 'sqrt') return Math.sqrt(Math.max(0, v));
  if (kind === 'log') return Math.log(Math.max(1, v)); // counts ≥ 1 → log(1)=0 is the floor
  return v;
};

/**
 * Map a count to a size in [minSize, maxSize]. `linear` is proportional; `sqrt`/`log` compress a long tail so
 * a single runaway tag never dwarfs everything (the standard tag-cloud damping). When all counts are equal
 * (range 0) every value gets maxSize. Non-finite → minSize (never NaN CSS).
 */
export function frequencyScale(count: number, opts: FrequencyScaleOptions): number {
  const minSize = opts.minSize ?? 12;
  const maxSize = opts.maxSize ?? 40;
  const scale = opts.scale ?? 'sqrt';
  if (!Number.isFinite(count)) return minSize;
  const lo = transform(opts.minCount, scale);
  const hi = transform(opts.maxCount, scale);
  if (hi - lo <= 0) return maxSize; // all equal → all big
  const t = Math.min(1, Math.max(0, (transform(count, scale) - lo) / (hi - lo)));
  return minSize + t * (maxSize - minSize);
}

/** Min/max counts in a tally (for feeding `frequencyScale`). Empty → {min:0, max:0}. */
export function countRange(tally: ReadonlyMap<string, number>): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of tally.values()) {
    if (c < min) min = c;
    if (c > max) max = c;
  }
  return tally.size === 0 ? { min: 0, max: 0 } : { min, max };
}
