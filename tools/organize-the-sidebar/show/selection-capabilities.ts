// packages/group/show/selection-capabilities.ts
//
// PURE selection→capability-gating flags for the board. Given the current
// selection, the board items, and the hidden set, decide which context-sensitive
// actions are MEANINGFUL right now — so the surface can hide dead no-op rows
// (L118): "Arrange as mind-map" only when the selection actually links nodes,
// "Collapse/Expand branch" only when the anchor has a connector-subtree with
// something to hide / restore, tag/fill editors only when the anchor carries them.
// Extracted out of the GroupBoardPanel show component so this gating logic is
// unit-testable and the god surface shrinks — zero behavior change, no hooks.
//
// The anchor is the LAST-selected item (the one a single-target action edits).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { itemTags } from './item-tags.ts';
import { itemFillColor } from './item-fill.ts';
import { descendantsViaConnectors, ancestorsViaConnectors } from '../do-work/batch-actions.ts';
import { presentationFrameOf } from '../do-work/board-frames.ts';
import { BOARD_ITEM_FACETS } from './board-item-facets.ts';
import { facetValues } from '../read-data/facet-filter.ts';

/** The context-sensitive capability flags a selection exposes. Each gates a row so
 *  the surface never shows an action that would be a no-op on the current target. */
export interface SelectionCapabilityFlags {
  /** The anchor item carries ≥1 tag (gates tag-edit / clear-tags). */
  hasTags: boolean;
  /** The anchor item carries a fill colour (gates fill-related rows). */
  hasFill: boolean;
  /** The anchor item carries a per-item bullet marker (gates "Select same marker"). */
  hasMarker: boolean;
  /** The anchor item carries a per-item shape (gates "Select same shape"). */
  hasShape: boolean;
  /** ≥1 connector links two SELECTED nodes (gates "Arrange as mind-map", #161). */
  selectionHasConnectors: boolean;
  /** The anchor has a connector-subtree with VISIBLE descendants (gates Collapse, #162). */
  anchorHasVisibleDescendants: boolean;
  /** The anchor has a connector-subtree with HIDDEN descendants (gates Expand, #162). */
  anchorHasHiddenDescendants: boolean;
  /** The anchor has ≥1 transitive ANCESTOR (an incoming connector) — gates "Select upstream". */
  anchorHasAncestors: boolean;
  /** The anchor is a presentation FRAME (gates "Select frame contents", #170). */
  anchorIsFrame: boolean;
  /** Per-facet count of DISTINCT values among the SELECTED items (keyed by BOARD_ITEM_FACETS id).
   *  Gates faceted bulk ops like "Color by tag" — a colour-BY grouping is dead unless the selection
   *  spans ≥2 values (L118). Generic over every facet; the fold names no specific facet. */
  distinctFacetValues: Readonly<Record<string, number>>;
}

/**
 * Derive the capability flags for the current selection. The anchor is the last id
 * in the selection (the single-target edit focus). Pure fold over the items — reads
 * self-describing DATA (tags, fill, connector endpoints) through the same helpers the
 * board renders with, so a new gate is a new flag here, never a branch in the surface.
 */
export function selectionCapabilityFlags(
  selectedIds: ReadonlySet<string>,
  items: readonly BoardItem[],
  hiddenIds: ReadonlySet<string>,
): SelectionCapabilityFlags {
  const sel = [...selectedIds];
  const anchor = sel[sel.length - 1] ?? null;
  const item = anchor ? items.find((i) => i.memberId === anchor) : undefined;

  // ≥1 connector links two SELECTED nodes (the connector itself need not be selected).
  const selSet = new Set(sel);
  const selectionHasConnectors = items.some(
    (i) =>
      itemIsConnector(i) &&
      selSet.has(i.extra.fromMemberId as string) &&
      selSet.has(i.extra.toMemberId as string),
  );

  // The anchor's connector-subtree: does it have anything visible (to hide) / hidden
  // (to restore)? Short-circuits once both are known.
  const descendants = anchor ? descendantsViaConnectors(items, anchor) : [];
  let visibleDesc = false;
  let hiddenDesc = false;
  for (const id of descendants) {
    if (hiddenIds.has(id)) hiddenDesc = true;
    else visibleDesc = true;
    if (visibleDesc && hiddenDesc) break;
  }

  // Distinct value count per facet among the SELECTED items — gates faceted bulk ops
  // ("Color by tag" is dead unless the selection spans ≥2 tags). Generic over every
  // BOARD_ITEM_FACETS extractor (L090 — this fold names no specific facet; `facetValues`
  // returns the distinct display values, whose count is what the gate reads).
  const selItems = items.filter((i) => selSet.has(i.memberId));
  const distinctFacetValues: Record<string, number> = {};
  for (const key of Object.keys(BOARD_ITEM_FACETS)) {
    distinctFacetValues[key] = facetValues(selItems, BOARD_ITEM_FACETS[key]).length;
  }

  return {
    hasTags: item ? itemTags(item).length > 0 : false,
    hasFill: item ? !!itemFillColor(item) : false,
    hasMarker: item ? typeof item.extra?.marker === 'string' && item.extra.marker.length > 0 : false,
    hasShape: item ? typeof item.extra?.shape === 'string' && item.extra.shape.length > 0 : false,
    selectionHasConnectors,
    anchorHasVisibleDescendants: visibleDesc,
    anchorHasHiddenDescendants: hiddenDesc,
    anchorHasAncestors: anchor ? ancestorsViaConnectors(items, anchor).length > 0 : false,
    anchorIsFrame: item ? presentationFrameOf(item) !== null : false,
    distinctFacetValues,
  };
}
