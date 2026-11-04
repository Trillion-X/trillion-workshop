// packages/group/do-work/tag-cooccurrence.ts
//
// TAG CO-OCCURRENCE — the board's TAG-RELATIONSHIP primitive (b117). The tag cloud (b111) COUNTS tags; text
// similarity (b110) relates ITEMS; this relates the TAGS THEMSELVES — which tags travel together, how strongly,
// and (from that) what tag a half-tagged card is probably missing.
//
// Input is the board as a list of tag SETS (one per card — `itemTags` in the show layer supplies them). From the
// pairwise co-occurrence of tags we derive:
//   • tagTotals      — per-tag item frequency (how many cards carry the tag)
//   • tagAffinities   — the strongest tag→tag pairs, scored by a DATA-selected measure
//   • suggestTags     — given a card's current tags, the tags that most often co-occur with them ("also tag…")
//
// The measure (Jaccard / cosine / raw count / lift) is DATA, not a branch: `COOCCURRENCE_MEASURES` is an
// injected-capability catalog (L069/L090) — a new scoring is one row, zero engine code. Pure leaf: deterministic
// (lexicographic tie-breaks, no `Math.random`/`Date.now`), zero imports.

/** A scored tag pair. `a` < `b` lexicographically (unordered). `count` = cards carrying BOTH. */
export interface TagPair {
  readonly a: string;
  readonly b: string;
  readonly count: number;
  readonly weight: number;
}

/** A suggested tag for a card, with the existing tag that most supports it. */
export interface TagSuggestion {
  readonly tag: string;
  readonly score: number;
  readonly from: string;
}

/**
 * A co-occurrence scoring measure. `co` = cards with both tags, `a`/`b` = each tag's own total, `n` = total cards.
 * The catalog is DATA — dispatch is blind to which measure runs.
 */
export interface CoOccurrenceMeasure {
  readonly id: string;
  readonly label: string;
  readonly weight: (co: number, a: number, b: number, n: number) => number;
}

const PAIR_SEP = "\u0000"; // null separator: a tag may contain a space but never a NUL

/** Normalize a raw tag to its canonical key (trim, strip leading #/@, lowercase). Empty → ''. */
export function normTag(tag: string): string {
  return (tag ?? '').trim().replace(/^[#@]+/, '').toLowerCase();
}

/** The distinct, normalized, non-empty tags of one card (a set — duplicates collapse). */
function cleanSet(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const k = normTag(raw);
    if (k) seen.add(k);
  }
  return [...seen];
}

/** Per-tag item frequency: how many cards carry each tag (once per card). */
export function tagTotals(sets: readonly (readonly string[])[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const raw of sets ?? []) {
    for (const t of cleanSet(raw)) totals.set(t, (totals.get(t) ?? 0) + 1);
  }
  return totals;
}

/** Raw co-occurrence counts, keyed `a\0b` with a < b. One increment per card per unordered pair. */
export function coPairCounts(sets: readonly (readonly string[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of sets ?? []) {
    const tags = cleanSet(raw).sort();
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const key = `${tags[i]}${PAIR_SEP}${tags[j]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * The DATA catalog of scoring measures (L069/L090).
 * - `together` (Jaccard): overlap ÷ union — 1 = always together, symmetric, bounded [0,1].
 * - `cosine`: overlap ÷ √(a·b) — like Jaccard but softer on lopsided totals, bounded [0,1].
 * - `count`: the raw number of cards carrying both — how much evidence there is.
 * - `lift`: (co·n)/(a·b) — how much MORE than chance the two co-occur (>1 = attracted, unbounded).
 * A new measure is one row; nothing else changes.
 */
export const COOCCURRENCE_MEASURES: readonly CoOccurrenceMeasure[] = [
  { id: 'together', label: 'Go together', weight: (co, a, b) => (a + b - co > 0 ? co / (a + b - co) : 0) },
  { id: 'cosine', label: 'Cosine', weight: (co, a, b) => (a > 0 && b > 0 ? co / Math.sqrt(a * b) : 0) },
  { id: 'count', label: 'Times together', weight: (co) => co },
  { id: 'lift', label: 'Lift (vs chance)', weight: (co, a, b, n) => (a > 0 && b > 0 ? (co * n) / (a * b) : 0) },
];

/** Look up a measure by id, falling back to the first (the maximally-capable default, L083). */
export function measureById(id: string | undefined, measures: readonly CoOccurrenceMeasure[] = COOCCURRENCE_MEASURES): CoOccurrenceMeasure {
  return measures.find((m) => m.id === id) ?? measures[0];
}

export interface TagAffinityOptions {
  readonly measure?: string;
  readonly minCount?: number;
  readonly limit?: number;
  readonly measures?: readonly CoOccurrenceMeasure[];
}

/**
 * The strongest tag→tag pairs, scored by the chosen measure and ranked worst-last.
 * Deterministic: ties break by count (desc) then the pair names (asc). `minCount` (default 1) drops noise;
 * `limit` keeps the top-N. Pairs with a non-positive weight are dropped.
 */
export function tagAffinities(sets: readonly (readonly string[])[], opts: TagAffinityOptions = {}): TagPair[] {
  const { measure, minCount = 1, limit, measures = COOCCURRENCE_MEASURES } = opts;
  const m = measureById(measure, measures);
  const totals = tagTotals(sets);
  const n = (sets ?? []).length;
  const pairs: TagPair[] = [];
  for (const [key, count] of coPairCounts(sets)) {
    if (count < minCount) continue;
    const [a, b] = key.split(PAIR_SEP);
    const weight = m.weight(count, totals.get(a) ?? 0, totals.get(b) ?? 0, n);
    if (weight > 0) pairs.push({ a, b, count, weight });
  }
  pairs.sort((p, q) => q.weight - p.weight || q.count - p.count || (p.a === q.a ? p.b.localeCompare(q.b) : p.a.localeCompare(q.a)));
  return typeof limit === 'number' ? pairs.slice(0, Math.max(0, limit)) : pairs;
}

export interface SuggestTagsOptions {
  readonly measure?: string;
  readonly limit?: number;
  readonly measures?: readonly CoOccurrenceMeasure[];
}

/**
 * Given a card's current tags, the tags that most co-occur with them across the board — "you might also tag…".
 * Each candidate's score sums its affinity to every current tag; `from` is the current tag contributing the most
 * (the reason to surface it). Tags the card already has are excluded. Deterministic tie-breaks. `have` is
 * normalized internally, so callers can pass raw tags.
 */
export function suggestTags(
  sets: readonly (readonly string[])[],
  have: readonly string[],
  opts: SuggestTagsOptions = {},
): TagSuggestion[] {
  const { measure, limit, measures = COOCCURRENCE_MEASURES } = opts;
  const m = measureById(measure, measures);
  const totals = tagTotals(sets);
  const n = (sets ?? []).length;
  const counts = coPairCounts(sets);
  const owned = new Set(cleanSet(have));
  if (owned.size === 0) return [];

  const pairKey = (x: string, y: string) => (x < y ? `${x}${PAIR_SEP}${y}` : `${y}${PAIR_SEP}${x}`);
  const scored = new Map<string, { score: number; from: string; fromScore: number }>();
  for (const cand of totals.keys()) {
    if (owned.has(cand)) continue;
    let score = 0;
    let from = '';
    let fromScore = -Infinity;
    for (const h of owned) {
      const co = counts.get(pairKey(cand, h)) ?? 0;
      if (co <= 0) continue;
      const w = m.weight(co, totals.get(cand) ?? 0, totals.get(h) ?? 0, n);
      if (w <= 0) continue;
      score += w;
      if (w > fromScore || (w === fromScore && h < from)) {
        fromScore = w;
        from = h;
      }
    }
    if (score > 0) scored.set(cand, { score, from, fromScore });
  }

  const out: TagSuggestion[] = [...scored.entries()].map(([tag, v]) => ({ tag, score: v.score, from: v.from }));
  out.sort((p, q) => q.score - p.score || p.tag.localeCompare(q.tag));
  return typeof limit === 'number' ? out.slice(0, Math.max(0, limit)) : out;
}
