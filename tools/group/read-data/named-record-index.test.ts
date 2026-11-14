// packages/group/read-data/named-record-index.test.ts
//
// Proves the GENERIC named-record store directly (independent of any record type): save/list/get/rename/
// archive/restore over a toy record, the archived-preserving update, the immutability no-ops, the
// fail-closed skip of a malformed payload, id/name fallbacks, and index isolation.

import { describe, it, expect } from 'vitest';
import { emptyGraph, addMember, ensureGroup, type GroupGraph, type AddressRef } from '../../ui/show/group/group-graph';
import {
  recordIndexRef, readRecords, readRejectedRecords, readActiveRecords, readArchivedRecords, getRecord, saveRecord,
  renameRecord, archiveRecord, restoreRecord, type RecordStoreSpec,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/named-record-index.ts';

interface Toy { readonly id: string; readonly name: string; readonly n: number }
const SPEC: RecordStoreSpec<Toy> = {
  indexFamily: 'test.toy-index',
  nodeFamily: 'test.toy',
  partKey: 'toy',
  kind: 'toy',
  parseRecord: (v) => {
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.n !== 'number') return null;
    return { id: o.id, name: o.name, n: o.n };
  },
  idOf: (t) => t.id,
  nameOf: (t) => t.name,
};
const INDEX = recordIndexRef(SPEC);
const rec = (id: string, name: string, n: number): Toy => ({ id, name, n });

describe('named-record-index — generic CRUD', () => {
  it('saves and reads back with the right fields (round-trip)', () => {
    const g = saveRecord(emptyGraph(), INDEX, { memberId: 'm1', recordId: 'r1', name: 'One', record: rec('r1', 'One', 7) }, SPEC);
    const active = readActiveRecords(g, INDEX, SPEC);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ memberId: 'm1', recordId: 'r1', name: 'One', archived: false, record: { n: 7 } });
  });

  it('update in place keeps the count + changes the fields', () => {
    let g = saveRecord(emptyGraph(), INDEX, { memberId: 'm1', recordId: 'r1', name: 'Draft', record: rec('r1', 'Draft', 1) }, SPEC);
    g = saveRecord(g, INDEX, { memberId: 'm1', recordId: 'r1', name: 'Final', record: rec('r1', 'Final', 2) }, SPEC);
    const all = readRecords(g, INDEX, SPEC);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Final');
    expect(all[0].record.n).toBe(2);
  });

  it('archive → archived list, restore → active; a re-save keeps it archived', () => {
    let g = saveRecord(emptyGraph(), INDEX, { memberId: 'm1', recordId: 'r1', name: 'One', record: rec('r1', 'One', 1) }, SPEC);
    g = archiveRecord(g, INDEX, 'm1');
    expect(readActiveRecords(g, INDEX, SPEC)).toHaveLength(0);
    expect(readArchivedRecords(g, INDEX, SPEC).map((r) => r.name)).toEqual(['One']);
    // a re-save does not un-archive
    g = saveRecord(g, INDEX, { memberId: 'm1', recordId: 'r1', name: 'One v2', record: rec('r1', 'One v2', 9) }, SPEC);
    expect(readActiveRecords(g, INDEX, SPEC)).toHaveLength(0);
    g = restoreRecord(g, INDEX, 'm1');
    expect(readActiveRecords(g, INDEX, SPEC).map((r) => r.name)).toEqual(['One v2']);
  });

  it('rename changes name, leaves record; no-ops return the same graph ref', () => {
    let g = saveRecord(emptyGraph(), INDEX, { memberId: 'm1', recordId: 'r1', name: 'Old', record: rec('r1', 'Old', 1) }, SPEC);
    const before = getRecord(g, INDEX, 'm1', SPEC)!.record;
    g = renameRecord(g, INDEX, 'm1', 'New');
    expect(getRecord(g, INDEX, 'm1', SPEC)?.name).toBe('New');
    expect(getRecord(g, INDEX, 'm1', SPEC)?.record).toEqual(before);
    const archived = archiveRecord(g, INDEX, 'm1');
    expect(archiveRecord(archived, INDEX, 'm1')).toBe(archived); // already archived → same ref
    expect(restoreRecord(g, INDEX, 'm1')).toBe(g); // already active → same ref
  });

  it('a malformed stored payload is skipped (fail-closed); id/name fall back to the record', () => {
    // write a member whose presentation.record is malformed, directly
    let g: GroupGraph = ensureGroup(emptyGraph(), INDEX);
    g = addMember(g, INDEX, { family: 'test.toy', parts: { toy: 'bad' } } as AddressRef, { memberId: 'bad', presentation: { kind: 'toy', record: { id: 'x' /* missing n */ } } });
    // and a good member WITHOUT a stored recordId/name → falls back to the record's own id/name
    g = addMember(g, INDEX, { family: 'test.toy', parts: { toy: 'g' } } as AddressRef, { memberId: 'good', presentation: { kind: 'toy', record: rec('rid', 'RName', 3) } });
    const rows = readRecords(g, INDEX, SPEC);
    expect(rows).toHaveLength(1); // the malformed one is skipped
    expect(rows[0]).toMatchObject({ memberId: 'good', recordId: 'rid', name: 'RName' });
    const before = JSON.stringify(g);
    expect(readRejectedRecords(g, INDEX, SPEC)).toEqual([{ memberId: 'bad', name: '', archived: false }]);
    expect(readRejectedRecords(archiveRecord(g, INDEX, 'bad'), INDEX, SPEC)).toEqual([{ memberId: 'bad', name: '', archived: true }]);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('separate index ids are isolated stores', () => {
    const other = recordIndexRef(SPEC, 'other');
    let g = saveRecord(emptyGraph(), INDEX, { memberId: 'm1', recordId: 'r1', name: 'Default', record: rec('r1', 'Default', 1) }, SPEC);
    g = saveRecord(g, other, { memberId: 'm1', recordId: 'r2', name: 'Other', record: rec('r2', 'Other', 2) }, SPEC);
    expect(readActiveRecords(g, INDEX, SPEC).map((r) => r.name)).toEqual(['Default']);
    expect(readActiveRecords(g, other, SPEC).map((r) => r.name)).toEqual(['Other']);
  });
});
