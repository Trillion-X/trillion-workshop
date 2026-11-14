// packages/group/read-data/saved-smart-set.test.ts
//
// Proves the saved-smart-set store (the THIRD consumer of the generic named-record-index): the save → read →
// RE-RESOLVE pipeline (a persisted query re-resolves against the live board, tracking changes), fail-closed
// query parsing (incl. prototype-pollution keys), that it resolves through filterByFacets identically, and that
// it is isolated from the report store (different index family).

import { describe, it, expect } from 'vitest';
import { emptyGraph } from '../../ui/show/group/group-graph';
import type { BoardItem } from './group-board-model';
import type { FacetExtractors } from 'trillion-workshop/tools/organize-the-sidebar/read-data/facet-filter.ts';
import {
  smartSetIndexRef, saveSmartSet, readActiveSmartSets, readArchivedSmartSets, getSmartSet, renameSmartSet,
  archiveSmartSet, restoreSmartSet, parseSmartQuery, smartQueryText, smartQueryIsEmpty, resolveSmartSet,
  compareSmartSet, replaceSmartSetQuery,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/saved-smart-set.ts';
import { reportIndexRef, readActiveReports } from 'trillion-workshop/tools/organize-the-sidebar/read-data/saved-report-store.ts';

const INDEX = smartSetIndexRef();
const card = (memberId: string, tags: string[], status: string): BoardItem =>
  ({ memberId, kind: 'note', x: 0, y: 0, w: 100, h: 40, text: '', extra: { tags, status }, isSection: false } as unknown as BoardItem);

// injected extractors (the surface supplies these; the leaf stays blind to which dimensions exist)
const EXTRACTORS: FacetExtractors<BoardItem> = {
  tag: (it) => ((it.extra?.tags as string[]) ?? []),
  status: (it) => (it.extra?.status ? [String(it.extra.status)] : []),
};

const board: BoardItem[] = [
  card('a', ['idea'], 'doing'),
  card('b', ['idea'], 'done'),
  card('c', ['chore'], 'doing'),
];

describe('parseSmartQuery — fail-closed', () => {
  it('accepts a clean Record<string,string[]> selection, rejects malformed shapes', () => {
    expect(parseSmartQuery({ selection: { tag: ['idea'], status: ['doing'] } })).toEqual({ selection: { tag: ['idea'], status: ['doing'] } });
    expect(parseSmartQuery({ selection: {} })).toEqual({ selection: {} });
    expect(parseSmartQuery({ selection: { tag: 'idea' } })).toBeNull(); // value not an array
    expect(parseSmartQuery({ selection: { tag: [1, 2] } })).toBeNull(); // non-string values
    expect(parseSmartQuery({ tag: ['idea'] })).toBeNull(); // no selection wrapper
    expect(parseSmartQuery('nope')).toBeNull();
    expect(parseSmartQuery(null)).toBeNull();
  });

  it('a prototype-pollution key survives parse as a plain own-property (no crash, no inheritance)', () => {
    const q = parseSmartQuery(JSON.parse('{"selection":{"__proto__":["x"],"tag":["idea"]}}'));
    expect(q).not.toBeNull();
    // the parsed selection is a null-proto object carrying the literal key, harmless downstream
    expect(Object.keys(q!.selection).sort()).toEqual(['__proto__', 'tag']);
    expect(({} as Record<string, unknown>).x).toBeUndefined(); // global proto untouched
  });
});

describe('smartQueryText / smartQueryIsEmpty', () => {
  it('summarizes a query and detects the unconstrained case', () => {
    expect(smartQueryText({ selection: { tag: ['idea', 'chore'], status: ['done'] } })).toBe('tag: idea, chore · status: done');
    expect(smartQueryText({ selection: {} })).toBe('everything');
    expect(smartQueryIsEmpty({ selection: {} })).toBe(true);
    expect(smartQueryIsEmpty({ selection: { tag: [] } })).toBe(true); // empty value list = no constraint
    expect(smartQueryIsEmpty({ selection: { tag: ['idea'] } })).toBe(false);
  });
});

describe('saved-smart-set store — save → read → RE-RESOLVE pipeline', () => {
  it('compares exact membership using the current cards, without modifying them', () => {
    const before = JSON.stringify(board);
    expect(compareSmartSet(board, { selection: { tag: ['idea'] } }, { selection: { status: ['doing'] } }, EXTRACTORS)).toEqual({
      beforeIds: ['a', 'b'], afterIds: ['a', 'c'], addedIds: ['c'], removedIds: ['b'], retainedIds: ['a'],
    });
    expect(JSON.stringify(board)).toBe(before);
  });

  it('replaces only reviewed filters while retaining current metadata and refusing stale or archived changes', () => {
    const query = { selection: { tag: ['idea'] } };
    const replacement = { selection: { status: ['doing'] } };
    const saved = saveSmartSet(emptyGraph(), INDEX, { memberId: 'm1', smartSetId: 's1', name: 'Ideas', savedAt: 123, query });
    const renamed = renameSmartSet(saved, INDEX, 'm1', 'Current name');
    const change = replaceSmartSetQuery(renamed, INDEX, 'm1', query, replacement);
    expect(change.error).toBeNull();
    expect(getSmartSet(change.graph, INDEX, 'm1')).toMatchObject({ smartSetId: 's1', name: 'Current name', savedAt: 123, query: replacement, archived: false });
    const stale = replaceSmartSetQuery(change.graph, INDEX, 'm1', query, query);
    expect(stale.error).toMatch(/changed/);
    expect(stale.graph).toBe(change.graph);
    const archived = archiveSmartSet(renamed, INDEX, 'm1');
    expect(replaceSmartSetQuery(archived, INDEX, 'm1', query, replacement).graph).toBe(archived);
    expect(replaceSmartSetQuery(renamed, INDEX, 'missing', query, replacement).error).toMatch(/changed/);
  });
  it('a persisted query re-resolves against the live board and tracks changes', () => {
    const query = { selection: { tag: ['idea'], status: ['doing'] } };
    const g = saveSmartSet(emptyGraph(), INDEX, { memberId: 'm1', smartSetId: 's1', name: 'Ideas in progress', query });
    const active = readActiveSmartSets(g, INDEX);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ memberId: 'm1', smartSetId: 's1', name: 'Ideas in progress', archived: false });
    expect(active[0].query).toEqual(query); // round-trips exactly
    // AND across facets, OR within: (tag=idea) AND (status=doing) → only card a
    expect(resolveSmartSet(board, active[0].query, EXTRACTORS)).toEqual(['a']);
    // the SAME saved query resolves differently once the board changes (b's status flips to doing)
    const boardLater = board.map((c) => (c.memberId === 'b' ? card('b', ['idea'], 'doing') : c));
    expect(resolveSmartSet(boardLater, active[0].query, EXTRACTORS)).toEqual(['a', 'b']);
  });

  it('rename / archive / restore behave like any named record', () => {
    let g = saveSmartSet(emptyGraph(), INDEX, { memberId: 'm1', smartSetId: 's1', name: 'A', query: { selection: { tag: ['idea'] } } });
    g = renameSmartSet(g, INDEX, 'm1', 'Renamed');
    expect(getSmartSet(g, INDEX, 'm1')?.name).toBe('Renamed');
    g = archiveSmartSet(g, INDEX, 'm1');
    expect(readActiveSmartSets(g, INDEX)).toHaveLength(0);
    expect(readArchivedSmartSets(g, INDEX).map((r) => r.name)).toEqual(['Renamed']);
    g = restoreSmartSet(g, INDEX, 'm1');
    expect(readActiveSmartSets(g, INDEX)).toHaveLength(1);
  });

  it('smart sets and reports are isolated (different index families)', () => {
    const g = saveSmartSet(emptyGraph(), INDEX, { memberId: 'm1', smartSetId: 's1', name: 'S', query: { selection: { tag: ['idea'] } } });
    expect(readActiveReports(g, reportIndexRef())).toHaveLength(0);
    expect(readActiveSmartSets(g, INDEX)).toHaveLength(1);
  });
});
