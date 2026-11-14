// packages/group/show/selection-capabilities.test.ts
//
// Pure proof of the selection→capability-gating flags. Builds a small connector
// tree (A→B→C) and asserts each flag reflects what actions are meaningful: mind-map
// arrange only when a connector links two selected nodes; collapse/expand only when
// the anchor's subtree has visible / hidden descendants; tags from the anchor DATA.

import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { selectionCapabilityFlags } from './selection-capabilities';

function base(memberId: string, extra: Record<string, unknown>): BoardItem {
  return {
    memberId,
    nodeRef: { family: 'group.board-item', parts: { board: 'b', item: memberId } },
    kind: 'note',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    isSection: false,
    childCount: 0,
    extra,
  };
}
const note = (id: string, extra: Record<string, unknown> = {}) => base(id, extra);
const conn = (id: string, from: string, to: string) => base(id, { fromMemberId: from, toMemberId: to });

// A→B→C mind-map: three nodes chained by two connectors.
const TREE: BoardItem[] = [
  note('A'),
  note('B'),
  note('C', { tags: ['goal'] }),
  conn('cAB', 'A', 'B'),
  conn('cBC', 'B', 'C'),
];
const set = (...ids: string[]) => new Set(ids);

describe('selectionCapabilityFlags', () => {
  it('empty selection → every flag false', () => {
    expect(selectionCapabilityFlags(set(), TREE, set())).toEqual({
      hasTags: false,
      hasFill: false,
      hasMarker: false,
      hasShape: false,
      selectionHasConnectors: false,
      anchorHasVisibleDescendants: false,
      anchorHasHiddenDescendants: false,
      anchorHasAncestors: false,
      anchorIsFrame: false,
      distinctFacetValues: { tag: 0, colorFamily: 0, kindFamily: 0, progress: 0, deadline: 0 },
    });
  });

  it('selectionHasConnectors is true only when a connector links two SELECTED nodes', () => {
    expect(selectionCapabilityFlags(set('A'), TREE, set()).selectionHasConnectors).toBe(false);
    expect(selectionCapabilityFlags(set('A', 'B'), TREE, set()).selectionHasConnectors).toBe(true);
    // A and C are not directly linked (only via B) → no direct connector between them.
    expect(selectionCapabilityFlags(set('A', 'C'), TREE, set()).selectionHasConnectors).toBe(false);
  });

  it('anchor descendants: all visible → visible flag only', () => {
    const f = selectionCapabilityFlags(set('A'), TREE, set());
    expect(f.anchorHasVisibleDescendants).toBe(true); // B, C hang off A
    expect(f.anchorHasHiddenDescendants).toBe(false);
  });

  it('a hidden descendant flips the hidden flag (both true when the subtree is mixed)', () => {
    const f = selectionCapabilityFlags(set('A'), TREE, set('C')); // C hidden, B visible
    expect(f.anchorHasVisibleDescendants).toBe(true);
    expect(f.anchorHasHiddenDescendants).toBe(true);
  });

  it('a leaf anchor (no descendants) has neither descendant flag', () => {
    const f = selectionCapabilityFlags(set('C'), TREE, set());
    expect(f.anchorHasVisibleDescendants).toBe(false);
    expect(f.anchorHasHiddenDescendants).toBe(false);
  });

  it('anchorHasAncestors: a root has none, a downstream leaf has ancestors (gates Select upstream)', () => {
    // TREE is A → B → C. A is the root (nothing leads into it); C has A and B upstream.
    expect(selectionCapabilityFlags(set('A'), TREE, set()).anchorHasAncestors).toBe(false);
    expect(selectionCapabilityFlags(set('C'), TREE, set()).anchorHasAncestors).toBe(true);
  });

  it('distinctFacetValues counts DISTINCT facet values among the SELECTED items only (gates Color-by)', () => {
    // Two tags across the selection → tag:2 (gates "Color by tag"); one unselected tag is ignored.
    const items = [note('a', { tags: ['idea'] }), note('b', { tags: ['risk'] }), note('c', { tags: ['idea'] }), note('u', { tags: ['other'] })];
    const f = selectionCapabilityFlags(set('a', 'b', 'c'), items, set());
    expect(f.distinctFacetValues.tag).toBe(2); // idea + risk among a,b,c ('other' unselected → excluded)
    // A single distinct tag → 1 → the "Color by tag" gate (≥2) is correctly closed.
    expect(selectionCapabilityFlags(set('a', 'c'), items, set()).distinctFacetValues.tag).toBe(1);
    // Empty selection → 0 for every facet.
    expect(selectionCapabilityFlags(set(), items, set()).distinctFacetValues.tag).toBe(0);
  });

  it('the anchor is the LAST-selected item — its tags drive hasTags', () => {
    // C carries a tag, A does not. Anchor = last id in the set iteration order.
    expect(selectionCapabilityFlags(set('A', 'C'), TREE, set()).hasTags).toBe(true); // anchor C
    expect(selectionCapabilityFlags(set('A'), TREE, set()).hasTags).toBe(false); // anchor A, untagged
  });

  it('hasFill is false when the anchor carries no fill (no visualLayerStack)', () => {
    expect(selectionCapabilityFlags(set('A'), TREE, set()).hasFill).toBe(false);
  });

  it('anchorIsFrame is true only when the anchor carries a presentationFrame facet (#170)', () => {
    const frame = note('F', { presentationFrame: { order: 0 } });
    const items = [...TREE, frame];
    expect(selectionCapabilityFlags(set('F'), items, set()).anchorIsFrame).toBe(true);
    expect(selectionCapabilityFlags(set('A'), items, set()).anchorIsFrame).toBe(false); // a note anchor
  });

  it('hasMarker gates Select-same-marker: true only when the anchor carries a per-item marker', () => {
    const items = [note('M', { marker: 'check' }), note('P')];
    expect(selectionCapabilityFlags(set('M'), items, set()).hasMarker).toBe(true);
    expect(selectionCapabilityFlags(set('P'), items, set()).hasMarker).toBe(false); // inherits board default → no per-item marker
    expect(selectionCapabilityFlags(set('A'), TREE, set()).hasMarker).toBe(false);
  });

  it('hasShape gates Select-same-shape: true only when the anchor carries a per-item shape', () => {
    const items = [note('S', { shape: 'diamond' }), note('P')];
    expect(selectionCapabilityFlags(set('S'), items, set()).hasShape).toBe(true);
    expect(selectionCapabilityFlags(set('P'), items, set()).hasShape).toBe(false);
    expect(selectionCapabilityFlags(set('A'), TREE, set()).hasShape).toBe(false);
  });
});
