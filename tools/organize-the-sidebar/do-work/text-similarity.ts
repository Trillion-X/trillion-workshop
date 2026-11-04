// packages/group/do-work/text-similarity.ts
//
// TEXT SIMILARITY — the generative primitive behind "find the DUPLICATE / near-identical notes" and "show me
// notes SIMILAR to this one" (the Notion/Roam dedupe + "related notes" canon). It is the CONTENT dual of the
// board's exact-match select-similar (`similarIds` groups by an identical tag/kind/colour KEY); this groups by
// FUZZY text overlap, so "Book flight to NYC" and "book the flight to nyc tomorrow" read as near-duplicates
// even though no field is byte-equal. The requests "dedupe / merge similar / group by content / rank related"
// are all ONE computation configured by the shingle size `k`, the tokenisation `mode` (word vs char), and the
// duplicate `threshold`.
//
// Mechanism: SHINGLING + JACCARD. A text becomes a SET of overlapping k-grams (word k-grams by default —
// robust to minor edits, order-sensitive enough to tell real notes apart); similarity = Jaccard |A∩B|/|A∪B|.
// No embeddings/model (that is the `knowledge-records`/`ai-memory` owner's job, Envelope-dispatched — this
// leaf stays a pure, deterministic, offline lexical measure; a god package would re-own the AI substrate).
//
// Pure leaf — zero imports, zero I/O, deterministic. The show/ wrapper injects `textOf` + builds a similarity
// facet for the b107 hull overlay (outline content-duplicate clusters, the b109-style compose).

export type ShingleMode = 'word' | 'char';

export interface ShingleOptions {
  /** k-gram size (default 2 → word bigrams). ≥ 1. */
  readonly k?: number;
  /** Tokenise by word (default) or character. */
  readonly mode?: ShingleMode;
}

/** Lowercase, collapse all whitespace to single spaces, trim — the ONE normalisation site (SSOT). */
export function normalizeText(s: string): string {
  return (typeof s === 'string' ? s : '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The set of overlapping k-grams of a text. Word mode = k consecutive words joined by a space; char mode = k
 * consecutive characters of the whitespace-collapsed string. A text with FEWER than k tokens degrades to a
 * single shingle of its whole normalised form (so "hi" still matches "hi" instead of vanishing). Empty text
 * → empty set.
 */
export function shingleSet(text: string, opts: ShingleOptions = {}): Set<string> {
  const k = Math.max(1, Math.floor(opts.k ?? 2));
  const mode = opts.mode ?? 'word';
  const norm = normalizeText(text);
  if (norm === '') return new Set();
  const tokens = mode === 'word' ? norm.split(' ') : Array.from(norm);
  if (tokens.length < k) return new Set([norm]); // too short for a k-gram → whole-string shingle
  const out = new Set<string>();
  const joiner = mode === 'word' ? ' ' : '';
  for (let i = 0; i + k <= tokens.length; i++) out.add(tokens.slice(i, i + k).join(joiner));
  return out;
}

/**
 * Jaccard similarity of two sets: |A∩B| / |A∪B|, in 0..1. Two EMPTY sets → 0 (no shared evidence — deliberate,
 * so blank notes don't all cluster as "duplicates"); one empty + one non-empty → 0.
 */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Similarity of two texts (0..1) via shingle-set Jaccard. Identical (post-normalisation) text → 1. */
export function textSimilarity(a: string, b: string, opts: ShingleOptions = {}): number {
  return jaccard(shingleSet(a, opts), shingleSet(b, opts));
}

export interface DuplicateOptions extends ShingleOptions {
  /** Min similarity for two texts to be "the same thing" (default 0.6). */
  readonly threshold?: number;
}

/**
 * Union-find over all text pairs with similarity ≥ threshold → clusters of near-duplicates (each an array of
 * INPUT INDICES, size ≥ 2, sorted; singletons dropped). Groups are transitively merged (a~b, b~c → {a,b,c}).
 * Shingle sets are computed ONCE per text (O(n) memory), then O(n²) pairwise — bounded for board sizes.
 * Deterministic (ascending index order throughout).
 */
export function duplicateGroups(texts: readonly string[], opts: DuplicateOptions = {}): number[][] {
  const n = texts.length;
  const threshold = Number.isFinite(opts.threshold) ? (opts.threshold as number) : 0.6;
  const sets = texts.map((t) => shingleSet(t, opts));
  const parent = Array.from({ length: n }, (_v, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); // point to the lower index → deterministic
  };
  for (let i = 0; i < n; i++) {
    if (sets[i].size === 0) continue; // an empty note is never a duplicate
    for (let j = i + 1; j < n; j++) {
      if (sets[j].size === 0) continue;
      if (jaccard(sets[i], sets[j]) >= threshold) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (sets[i].size === 0) continue;
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => g.slice().sort((a, b) => a - b));
}

export interface RankSimilarOptions extends ShingleOptions {
  /** Drop candidates below this similarity (default 0 → return all ranked). */
  readonly minScore?: number;
  /** Cap the result length. */
  readonly limit?: number;
}

/**
 * Rank candidate texts by similarity to a target (descending score, then ascending index on ties). The target
 * itself is excluded when `excludeIndex` is given. Deterministic. Powers "notes similar to this one" (the
 * content sibling of exact-match select-similar).
 */
export function rankSimilar(
  target: string,
  candidates: readonly string[],
  opts: RankSimilarOptions & { readonly excludeIndex?: number } = {},
): { index: number; score: number }[] {
  const targetSet = shingleSet(target, opts);
  const minScore = opts.minScore ?? 0;
  const scored: { index: number; score: number }[] = [];
  candidates.forEach((c, i) => {
    if (i === opts.excludeIndex) return;
    const score = jaccard(targetSet, shingleSet(c, opts));
    if (score >= minScore) scored.push({ index: i, score });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return typeof opts.limit === 'number' ? scored.slice(0, Math.max(0, opts.limit)) : scored;
}
