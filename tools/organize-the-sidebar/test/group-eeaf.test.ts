// packages/group/read-data/group-eeaf.test.ts
//
// The EEAF translation boundary must round-trip the leaf faithfully: records →
// GroupGraph → (leaf op) → write-set → records, with the write-set being minimal
// (only changed groups written, vanished groups deleted).

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import {
  foldGroupRecords,
  groupGraphWriteSet,
  groupRecordAddress,
  type GroupRecord,
} from '../read-data/group-eeaf.ts';
import {
  emptyGraph,
  addMember,
  groupMembers,
  ungroupMembers,
  membersOf,
  type GroupGraph,
} from '../../make-screen-layouts-and-controls/parts/ui/show/group/group-graph.ts';
import type { AddressRef } from '../../turn-frames-into-slides/read-data/visual-layer-types.ts';

const ref = (family: string, id: string): AddressRef => ({ family, parts: { id } });
const BOARD = ref('board', 'b1');
const SUB = ref('group', 'sub1');

/** Serialize a whole graph to log records, as the writer would. */
function graphToRecords(graph: GroupGraph): GroupRecord[] {
  return Object.values(graph.groups).map((g) => ({
    address: groupRecordAddress(g.groupRef),
    value_json: g,
  }));
}

describe('group-eeaf — fold (read path)', () => {
  it('folds raw records into a GroupGraph; parses JSON-string values', () => {
    let g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    g = addMember(g, BOARD, ref('tab', 't2'), { memberId: 'm2' });
    const records = graphToRecords(g);
    // one record arrives as a JSON string (the log sometimes stores text)
    records[0] = { ...records[0], value_json: JSON.stringify(records[0].value_json) };
    const folded = foldGroupRecords(records);
    expect(membersOf(folded, BOARD).map((m) => m.memberId)).toEqual(['m1', 'm2']);
  });

  it('skips malformed records (blind tolerance) and lets later records win', () => {
    let g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    const good = graphToRecords(g)[0];
    let g2 = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    g2 = addMember(g2, BOARD, ref('tab', 't2'), { memberId: 'm2' });
    const newer = graphToRecords(g2)[0];
    const folded = foldGroupRecords([
      { address: 'x', value_json: 'not json' },
      { address: groupRecordAddress(BOARD), value_json: { junk: true } },
      good,
      newer, // same address, later → wins
    ]);
    expect(membersOf(folded, BOARD).map((m) => m.memberId)).toEqual(['m1', 'm2']);
  });

  it('empty input → empty graph', () => {
    expect(foldGroupRecords([]).groups).toEqual({});
  });

  it('drops tombstoned (status:deleted) group records', () => {
    let g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    const live = graphToRecords(g)[0];
    const tombstoned = { address: live.address, value_json: { ...(live.value_json as object), status: 'deleted' } };
    expect(foldGroupRecords([live, tombstoned]).groups).toEqual({}); // later tombstone wins → gone
  });
});

describe('group-eeaf — write-set (write path)', () => {
  it('a single addMember writes exactly one group; unchanged groups are not written', () => {
    let before = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    before = addMember(before, SUB, ref('tab', 's1'), { memberId: 'sm1' }); // an unrelated group
    const after = addMember(before, BOARD, ref('tab', 't2'), { memberId: 'm2' });
    const { upserts, tombstones } = groupGraphWriteSet(before, after);
    expect(tombstones).toEqual([]);
    expect(upserts.map((u) => u.address)).toEqual([groupRecordAddress(BOARD)]); // SUB untouched → no write
  });

  it('groupMembers writes TWO groups (parent + new sub-group), zero deletes', () => {
    let before = emptyGraph();
    for (const i of [1, 2, 3]) before = addMember(before, BOARD, ref('tab', `t${i}`), { memberId: `m${i}` });
    const after = groupMembers(before, BOARD, ['m1', 'm2'], SUB, { wrapperMemberId: 'w' });
    const { upserts, tombstones } = groupGraphWriteSet(before, after);
    expect(tombstones).toEqual([]);
    expect(upserts.map((u) => u.address).sort()).toEqual(
      [groupRecordAddress(BOARD), groupRecordAddress(SUB)].sort(),
    );
  });

  it('ungroupMembers writes the parent and DELETES the dissolved sub-group', () => {
    let g = emptyGraph();
    for (const i of [1, 2, 3]) g = addMember(g, BOARD, ref('tab', `t${i}`), { memberId: `m${i}` });
    const grouped = groupMembers(g, BOARD, ['m1', 'm2'], SUB, { wrapperMemberId: 'w' });
    const ungrouped = ungroupMembers(grouped, BOARD, 'w');
    const { upserts, tombstones } = groupGraphWriteSet(grouped, ungrouped);
    expect(upserts.map((u) => u.address)).toEqual([groupRecordAddress(BOARD)]);
    expect(tombstones.map((t) => t.address)).toEqual([groupRecordAddress(SUB)]);
  });

  it('no-op mutation writes nothing (structural sharing → O(changed))', () => {
    const g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    const { upserts, tombstones } = groupGraphWriteSet(g, g);
    expect(upserts).toEqual([]);
    expect(tombstones).toEqual([]);
  });

  it('full round-trip: records → fold → leaf op → write-set applied → records match graph', () => {
    let before = emptyGraph();
    for (const i of [1, 2, 3, 4]) before = addMember(before, BOARD, ref('tab', `t${i}`), { memberId: `m${i}` });
    const folded = foldGroupRecords(graphToRecords(before));
    const after = groupMembers(folded, BOARD, ['m2', 'm3'], SUB, { wrapperMemberId: 'w' });
    const { upserts } = groupGraphWriteSet(folded, after);
    // apply the write-set onto the record store, then re-fold
    const store = new Map(graphToRecords(folded).map((r) => [r.address, r] as const));
    for (const u of upserts) store.set(u.address, { address: u.address, value_json: u.value_json });
    const refolded = foldGroupRecords([...store.values()]);
    expect(membersOf(refolded, BOARD).map((m) => m.memberId)).toEqual(['m1', 'w', 'm4']);
    expect(membersOf(refolded, SUB).map((m) => m.memberId)).toEqual(['m2', 'm3']);
  });
});

describe('address-spoof integrity + null-envelope safety (cont.98 batch-13)', () => {
  it('rejects a record whose payload groupRef does not match its stored address (no cross-address tombstone)', () => {
    const g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    const legitValue = Object.values(g.groups)[0];
    const legit: GroupRecord = { address: groupRecordAddress(BOARD), value_json: legitValue };
    // A hostile record STORED at SUB's address but DECLARING the BOARD groupRef + a delete. Under the
    // old code this tombstoned BOARD (keyed by payload.groupRef); now the address mismatch drops it.
    const spoof: GroupRecord = {
      address: groupRecordAddress(SUB),
      value_json: { ...(legitValue as object), status: 'deleted' },
    };
    const folded = foldGroupRecords([legit, spoof]);
    expect(membersOf(folded, BOARD).map((m) => m.memberId)).toEqual(['m1']); // BOARD survives the spoof
  });

  it('a null / malformed envelope entry is skipped, never crashes the fold', () => {
    const g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    const legit: GroupRecord = { address: groupRecordAddress(BOARD), value_json: Object.values(g.groups)[0] };
    expect(() =>
      foldGroupRecords([null as unknown as GroupRecord, legit, undefined as unknown as GroupRecord]),
    ).not.toThrow();
    expect(membersOf(foldGroupRecords([null as unknown as GroupRecord, legit]), BOARD).map((m) => m.memberId)).toEqual(['m1']);
  });
});
