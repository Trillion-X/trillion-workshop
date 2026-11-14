// packages/group/read-data/arrangement-library-actions.test.ts
import { describe, it, expect } from 'vitest';
import {
  runArrangementLibraryAction,
  isLibraryManageAction,
  ARRANGEMENT_LIBRARY_ACTIONS,
} from './arrangement-library-actions';
import { readSavedArrangementLibrary } from './saved-arrangement';
import { saveCollection, readActiveCollections } from './collection-store';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';

const IDX: AddressRef = { input: 'published-record', identity: 'collection-index' };

// A collection seeded into the store: its row in the library carries a memberId +
// full capabilities, so it is a valid target for every manage action.
function seedCollection(name = 'My Layout') {
  let g = emptyGraph();
  g = saveCollection(g, IDX, {
    memberId: 'm-1',
    collectionId: 'col-1',
    name,
    record: { id: 'col-1', name, items: [{ id: 'a', kind: 'note', x: 0, y: 0, w: 4, h: 3, text: 'hi' }] },
  });
  return g;
}

function collectionRow(g = seedCollection()) {
  const lib = readSavedArrangementLibrary(g, IDX, { includeTemplates: false });
  const row = lib.find((r) => r.memberId === 'm-1');
  if (!row) throw new Error('seeded collection row missing');
  return { g, row };
}

describe('arrangement-library-actions — DATA-keyed manage dispatch', () => {
  it('exposes exactly the store-manage actions (apply is NOT one)', () => {
    expect(Object.keys(ARRANGEMENT_LIBRARY_ACTIONS).sort()).toEqual(['archive', 'duplicate', 'rename', 'restore']);
    expect(isLibraryManageAction('rename')).toBe(true);
    expect(isLibraryManageAction('apply')).toBe(false);
    expect(isLibraryManageAction('nonsense')).toBe(false);
  });

  it('rename routes to renameCollection', () => {
    const { g, row } = collectionRow();
    const next = runArrangementLibraryAction(g, IDX, 'rename', row, { name: 'Renamed' });
    const cols = readActiveCollections(next, IDX);
    expect(cols.find((c) => c.memberId === 'm-1')?.name).toBe('Renamed');
  });

  it('archive removes the collection from the active picker; restore brings it back', () => {
    const { g, row } = collectionRow();
    const archived = runArrangementLibraryAction(g, IDX, 'archive', row, {});
    expect(readActiveCollections(archived, IDX).some((c) => c.memberId === 'm-1')).toBe(false);
    const restored = runArrangementLibraryAction(archived, IDX, 'restore', row, {});
    expect(readActiveCollections(restored, IDX).some((c) => c.memberId === 'm-1')).toBe(true);
  });

  it('duplicate mints a second active collection carrying the same payload', () => {
    const { g, row } = collectionRow();
    const dup = runArrangementLibraryAction(g, IDX, 'duplicate', row, {
      newMemberId: 'm-2',
      newCollectionId: 'col-2',
      name: 'Copy',
    });
    const cols = readActiveCollections(dup, IDX);
    expect(cols).toHaveLength(2);
    expect(cols.find((c) => c.memberId === 'm-2')?.name).toBe('Copy');
  });

  it('unknown / apply action is a no-op on the graph (board panel owns apply)', () => {
    const { g, row } = collectionRow();
    expect(runArrangementLibraryAction(g, IDX, 'apply', row, {})).toBe(g);
    expect(runArrangementLibraryAction(g, IDX, 'zzz', row, {})).toBe(g);
  });

  it('guards a manage action when the row has no memberId (e.g. a static template)', () => {
    const { g, row } = collectionRow();
    const templateLikeRow = { ...row, memberId: undefined };
    // rename with no memberId returns the graph untouched (belt-and-braces past the UI capability gate)
    expect(runArrangementLibraryAction(g, IDX, 'rename', templateLikeRow, { name: 'x' })).toBe(g);
  });
});
