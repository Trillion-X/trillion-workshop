// packages/group/read-data/collection-search.ts
//
// Pure, deterministic keyword filter + rank over a collection catalog. This is the
// off-the-shelf keyword layer of "template library search"; semantic/embedding search
// is deferred to the knowledge-records package (this leaf never touches a model or I/O).
//
// The mechanism is two ordered phases:
//   1. FILTER — narrow the catalog by the DATA-driven multi-facet filter (`facet-filter.ts`):
//               AND across facet keys, OR within a key (category ∈ {…} AND tag ∈ {…}). The
//               facet dimensions are INJECTED extractors, so category/tag are not special-
//               cased here — a new facet is one extractor row, zero change to this leaf.
//   2. RANK   — score the survivors against a tokenized free-text query, weighting a
//               hit by WHERE it was found (name > tag > description).
//
// Weights live in one place (FIELD_WEIGHTS) so the ranking policy is data, not scattered
// magic numbers. Sort is score-descending with a STABLE tie-break on original input order
// (an index carried alongside so `.sort` cannot reorder equal scores unpredictably).
//
// No I/O, no domain knowledge beyond the minimal self-describing shapes below.

import { filterByFacets, type FacetExtractors, type FacetSelection } from './facet-filter.ts';

/** A catalog entry that can be searched. All matchable text is optional except id/name. */
export interface SearchableCollection {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly category?: string;
}

/** The DEFAULT facet dimensions over a `SearchableCollection` — each reads the shape's OWN
 *  declared fields (not a closed capability registry): `category` (single) + `tag` (many).
 *  A caller filtering a different row type, or adding an `author`/`origin` facet, injects
 *  its own map; the generic `facet-filter` engine names none of these (enum-dissolution). */
export const COLLECTION_FACETS: FacetExtractors<SearchableCollection> = {
  category: (e) => (e.category ? [e.category] : []),
  tag: (e) => e.tags ?? [],
};

/** A keyword query: free text plus a DATA-driven multi-facet selection (`{category:[…],
 *  tag:[…]}`). The old closed `tag?`/`category?` scalar fields are dissolved into `facets`. */
export interface SearchQuery {
  readonly text?: string;
  readonly facets?: FacetSelection;
}

/** A survivor of the search, with its accumulated relevance score. */
export interface RankedResult {
  readonly id: string;
  readonly score: number;
}

// Per-field contribution to score for each query token substring-found in that field.
const FIELD_WEIGHTS = { name: 3, tag: 2, description: 1 } as const;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Filter `entries` by the multi-facet selection (`facet-filter`, injected `extractors`,
 * default = category+tag), then rank the survivors by `query.text`. When text is present,
 * zero-score entries are excluded. When text is empty/absent, every filtered entry is kept
 * with score 0. Sort: score DESC, ties broken by original input order (stable). Empty → [].
 */
export function searchCollections(
  entries: readonly SearchableCollection[],
  query: SearchQuery,
  extractors: FacetExtractors<SearchableCollection> = COLLECTION_FACETS,
): RankedResult[] {
  if (entries.length === 0) return [];

  const tokens = tokenize(query.text ?? "");
  const hasText = tokens.length > 0;

  // Phase 1: FILTER — the DATA-driven facet pass (AND across keys, OR within), carrying each
  // survivor's ORIGINAL index so the rank tie-break stays stable against the full input.
  const survivors = filterByFacets(
    entries.map((entry, order) => ({ entry, order })),
    query.facets ?? {},
    Object.fromEntries(
      Object.entries(extractors).map(([k, fn]) => [k, (row: { entry: SearchableCollection }) => fn(row.entry)]),
    ),
  );

  const scored: Array<{ id: string; score: number; order: number }> = [];

  survivors.forEach(({ entry, order }) => {
    // Phase 2: RANK. `entry.name` is declared string but the entry is UNTRUSTED DATA (an imported
    // collection) — a non-string name would crash `.toLowerCase()`; coerce so the leaf defends its
    // own boundary (mirrors description/tags, already `?? ''`/`?? []`).
    const name = String(entry.name ?? '').toLowerCase();
    const description = (entry.description ?? "").toLowerCase();
    const tags = (entry.tags ?? []).map((t) => t.toLowerCase());

    let score = 0;
    for (const token of tokens) {
      if (name.includes(token)) score += FIELD_WEIGHTS.name;
      if (tags.some((t) => t.includes(token))) score += FIELD_WEIGHTS.tag;
      if (description.includes(token)) score += FIELD_WEIGHTS.description;
    }

    if (hasText && score === 0) return; // exclude no-match entries when searching by text

    scored.push({ id: entry.id, score, order });
  });

  // Stable sort: score DESC, ties → original input order.
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.order - b.order));

  return scored.map(({ id, score }) => ({ id, score }));
}
