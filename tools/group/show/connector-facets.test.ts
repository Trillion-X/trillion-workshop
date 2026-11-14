// packages/group/show/connector-facets.test.ts
//
// Proof of the RELATIONSHIP-TYPE focus facet over connectors: human labels from the relation
// catalog (never raw ids), untyped connectors read the default kind, non-connectors have none,
// and `dimmedConnectorIds` returns exactly the connectors OUTSIDE the active relation focus.

import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { relationLabelOf, CONNECTOR_ITEM_FACETS, CONNECTOR_FOCUS_FACETS, dimmedConnectorIds, focusedConnectorIds } from './connector-facets';

const conn = (id: string, relationKind?: string): BoardItem =>
  ({ memberId: id, kind: 'connector', x: 0, y: 0, w: 0, h: 0, isSection: false, childCount: 0,
     extra: { fromMemberId: 'a', toMemberId: 'b', ...(relationKind ? { relationKind } : {}) } } as unknown as BoardItem);
const node = (id: string): BoardItem =>
  ({ memberId: id, kind: 'note', x: 0, y: 0, w: 100, h: 60, isSection: false, childCount: 0, extra: {} } as unknown as BoardItem);

const ids = (xs: readonly string[]) => [...xs].sort();

describe('relationLabelOf', () => {
  it('maps a typed connector to its HUMAN catalog label, never the raw id', () => {
    expect(relationLabelOf(conn('c1', 'blocks'))).toEqual(['blocks']);
    expect(relationLabelOf(conn('c2', 'depends-on'))).toEqual(['depends on']); // id "depends-on" → label "depends on"
  });
  it('an untyped connector reads the default relationship kind (so every line is focusable)', () => {
    expect(relationLabelOf(conn('c3'))).toEqual(['relates to']); // DEFAULT_RELATION_KIND = relates-to
  });
  it('a non-connector item has no relationship value', () => {
    expect(relationLabelOf(node('n1'))).toEqual([]);
  });
  it('an unknown relationship kind falls back to a de-slugged label (L083, never crashes)', () => {
    expect(relationLabelOf(conn('c4', 'custom_rel'))).toEqual(['custom rel']);
  });
  it('CONNECTOR_ITEM_FACETS.relationKind is the same extractor; the descriptor is labelled Relationship', () => {
    expect(CONNECTOR_ITEM_FACETS.relationKind(conn('c5', 'blocks'))).toEqual(['blocks']);
    expect(CONNECTOR_FOCUS_FACETS).toEqual([{ key: 'relationKind', label: 'Relationship' }]);
  });
});

describe('dimmedConnectorIds', () => {
  const items = [conn('c1', 'blocks'), conn('c2', 'depends-on'), conn('c3', 'blocks'), conn('c4')];

  it('no active relation focus → nothing dimmed', () => {
    expect(dimmedConnectorIds(items, {})).toEqual([]);
  });
  it('focus on one kind → every connector NOT of that kind is dimmed', () => {
    // Focus "blocks" → c1,c3 stay bright; c2 (depends-on) + c4 (relates-to) dim.
    expect(ids(dimmedConnectorIds(items, { relationKind: ['blocks'] }))).toEqual(['c2', 'c4']);
  });
  it('matches on the HUMAN label (label-space), so "depends on" selects the depends-on line', () => {
    expect(ids(dimmedConnectorIds(items, { relationKind: ['depends on'] }))).toEqual(['c1', 'c3', 'c4']);
  });
  it('OR within the facet → focusing two kinds keeps both bright', () => {
    // blocks OR depends-on → only c4 (relates-to) dims.
    expect(dimmedConnectorIds(items, { relationKind: ['blocks', 'depends on'] })).toEqual(['c4']);
  });
});

describe('focusedConnectorIds — the complement (the lines to SELECT)', () => {
  const items = [conn('c1', 'blocks'), conn('c2', 'depends-on'), conn('c3', 'blocks'), conn('c4')];

  it('no active focus → nothing focused', () => {
    expect(focusedConnectorIds(items, {})).toEqual([]);
  });
  it('focus on one kind → exactly the matching lines (the complement of dimmed)', () => {
    expect(ids(focusedConnectorIds(items, { relationKind: ['blocks'] }))).toEqual(['c1', 'c3']);
  });
  it('focused ∪ dimmed = every connector, disjoint (a clean partition)', () => {
    const focus = { relationKind: ['blocks'] };
    const focused = focusedConnectorIds(items, focus);
    const dimmed = dimmedConnectorIds(items, focus);
    expect(ids([...focused, ...dimmed])).toEqual(['c1', 'c2', 'c3', 'c4']); // covers all
    expect(focused.some((id) => dimmed.includes(id))).toBe(false); // disjoint
  });
});
