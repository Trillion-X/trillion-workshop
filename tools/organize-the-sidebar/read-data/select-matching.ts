// packages/group/read-data/select-matching.ts
//
// SELECT-MATCHING — select every card that shares a facet value with the seeds. The ATTRIBUTE-space analogue of
// `growSelection` (b185, which grows a selection over the relation GRAPH): this grows a selection over a shared
// ATTRIBUTE. It is the fourth selection modality, completing the family — by ANALYSIS (`reportSelect`, b180), by
// GEOMETRY (`itemsInRect`, b184), by CONNECTIVITY (`growSelection`, b185), and now by ATTRIBUTE.
//
// This DISSOLVES the five hardcoded `selectSameKind`/`selectSameTag`/`selectSameFill`/`selectSameMarker`/
// `selectSameShape` UI-ctx methods (batch-actions) into ONE blind leaf: the facet is DATA — a `FacetExtract`
// (the same injected extractor the whole reducer family shares) — so a new "select same X" is a new DATA row,
// never a new method (L063/L069/enum-dissolution). Because the facet is DATA, facets the old methods never had
// come for free: `cluster` (select the same graph cluster) and `progress-band` (select the same progress band)
// work with zero new code. Pure, deterministic; owns no facet vocabulary (the extractor is supplied).

import type { BoardItem } from './group-board-model.ts';
import type { FacetExtract } from './board-facet-census.ts';
import { dimensionDefById } from './board-report.ts';

/** The set of facet values carried by the seed items (the values we will match against). */
function seedFacetValues(items: readonly BoardItem[], seedIds: readonly string[], facet: FacetExtract): Set<string> {
  const seeds = new Set(seedIds);
  const values = new Set<string>();
  for (const it of items) {
    if (seeds.has(it.memberId)) for (const v of facet(it)) values.add(v);
  }
  return values;
}

/**
 * Select every card sharing ANY facet value with the seeds. The seeds define a value-set (the union of their
 * facet values); every card whose facet values intersect that set is returned — so matching seeds are naturally
 * included. A seed carrying NO facet value contributes nothing (nothing to match on); if EVERY seed is
 * value-less the result is empty. Deterministic (input order). Pure — the facet is the only source of "sameness".
 */
export function selectMatching(items: readonly BoardItem[], seedIds: readonly string[], facet: FacetExtract): string[] {
  const wanted = seedFacetValues(items, seedIds, facet);
  if (wanted.size === 0) return [];
  const out: string[] = [];
  for (const it of items) {
    if (facet(it).some((v) => wanted.has(v))) out.push(it.memberId);
  }
  return out;
}

/**
 * DATA-driven form: select-same over a board DIMENSION named by key (`tag`/`color`/`kind`/`cluster`/
 * `progress-band` — the reducer family's `BOARD_DIMENSIONS`, so the FULL catalog including graph-cluster and
 * measure-band is reachable by a string). Resolves the `FacetExtract` from the dimension catalog and delegates
 * to `selectMatching`. An unknown key → [] (fail-closed, never a throw). This is what a "Select same …" menu row
 * dispatches: a DATA key, not a hand-written method.
 */
export function selectMatchingByDimension(items: readonly BoardItem[], seedIds: readonly string[], dimensionKey: string): string[] {
  const def = dimensionDefById(dimensionKey);
  if (!def) return [];
  return selectMatching(items, seedIds, def.extract(items));
}
