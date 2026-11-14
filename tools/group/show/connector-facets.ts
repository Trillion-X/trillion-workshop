// packages/group/show/connector-facets.ts
//
// The RELATIONSHIP-TYPE focus facet — the connector-shape sibling of the node focus in
// `board-item-facets.ts`. The board's node focus (tag/color/type) dims NODES; this dims
// CONNECTORS by their relationship kind ("show only the depends-on / blocks lines"). It is
// the SAME generic `facet-filter` primitive with a connector extractor, kept as an INDEPENDENT
// selection (a connector's `relationKind` in the node selection would fail-closed in
// `matchesFacets` and dim every node — Codex GPT-5.5 convergence, 2026-07-05).
//
// Chips render the HUMAN relationship LABEL from the relation catalog (never the raw id) —
// mirroring how `kindFamilyOf` prevents raw-kind leakage (L114).

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { hasActiveFacets, matchesFacets, type FacetExtractors, type FacetSelection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/facet-filter.ts';
import { relationKindSpec, DEFAULT_RELATION_KINDS, type RelationKindSpec } from '../read-data/relation-kind-catalog';
import { DEFAULT_RELATION_KIND } from '../read-data/relationship-graph';
import type { BoardFocusFacet } from './board-item-facets';

/**
 * The human relationship LABEL a connector carries, via the relation catalog (e.g. "depends on").
 * A non-connector item has none (`[]`); an untyped connector reads the default kind's label, so
 * every connector is focusable. Label-space (not raw ids) so the chips read human copy and match
 * label-vs-label — a raw relationKind never surfaces (L114).
 */
export function relationLabelOf(
  item: BoardItem,
  catalog: Readonly<Record<string, RelationKindSpec>> = DEFAULT_RELATION_KINDS,
): readonly string[] {
  if (!itemIsConnector(item)) return [];
  const ex = (item.extra ?? {}) as { relationKind?: unknown };
  const raw = typeof ex.relationKind === 'string' && ex.relationKind.length > 0 ? ex.relationKind : DEFAULT_RELATION_KIND;
  return [relationKindSpec(raw, catalog).label];
}

/** The connector facet map — one dimension, `relationKind`, reading the human label. A future
 *  connector facet (weight, direction) is one more extractor row, zero engine change (L069). */
export const CONNECTOR_ITEM_FACETS: FacetExtractors<BoardItem> = {
  relationKind: (it) => relationLabelOf(it),
};

/** The focus-bar descriptor(s) for the connector facet cluster (labelled "Relationship"). */
export const CONNECTOR_FOCUS_FACETS: readonly BoardFocusFacet[] = [
  { key: 'relationKind', label: 'Relationship' },
];

/**
 * The connectors that do NOT match the active relationship focus → the ones to DIM (memberIds).
 * Empty when no relation facet is active (nothing to dim). Blind reuse of `matchesFacets` over the
 * connector extractor map — the same predicate the node focus uses, a different item shape.
 */
export function dimmedConnectorIds(
  connectorItems: readonly BoardItem[],
  facets: FacetSelection,
  extractors: FacetExtractors<BoardItem> = CONNECTOR_ITEM_FACETS,
): string[] {
  if (!hasActiveFacets(facets)) return [];
  return connectorItems.filter((it) => !matchesFacets(it, facets, extractors)).map((it) => it.memberId);
}

/**
 * The connectors that DO match the active relationship focus (memberIds) — the complement of
 * `dimmedConnectorIds`. Empty when no relation facet is active. Turns the read-only focus into an
 * actionable SELECTION (select all the "blocks" lines → bulk delete/restyle them), mirroring the
 * node `focusedItemIds`.
 */
export function focusedConnectorIds(
  connectorItems: readonly BoardItem[],
  facets: FacetSelection,
  extractors: FacetExtractors<BoardItem> = CONNECTOR_ITEM_FACETS,
): string[] {
  if (!hasActiveFacets(facets)) return [];
  return connectorItems.filter((it) => matchesFacets(it, facets, extractors)).map((it) => it.memberId);
}
