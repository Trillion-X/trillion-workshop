// packages/group/do-work/group-mutation-writes.test.ts
//
// The persistence builder must turn ANY leaf transition into a correct engine
// write-batch — with zero per-operation knowledge.

import { describe, it, expect, vi } from 'vitest';
import {
  buildGroupWriteBatch,
  persistGroupMutation,
  ENGINE_OPERATION_LABEL_TARGET,
  ENGINE_WRITE_BATCH_OPERATION,
} from 'trillion-workshop/tools/organize-the-sidebar/do-work/group-mutation-writes.ts';
import { groupRecordAddress } from 'trillion-workshop/tools/organize-the-sidebar/read-data/group-eeaf.ts';
import {
  emptyGraph,
  addMember,
  moveMember,
  groupMembers,
  ungroupMembers,
  ensureGroup,
} from '../../ui/show/group/group-graph';
import type { AddressRef } from '../../ui/show/visual-layer-stack/visual-layer-types';

const ref = (family: string, id: string): AddressRef => ({ family, parts: { id } });
const BOARD = ref('board', 'b1');
const SUB = ref('group', 'sub1');

describe('group-mutation-writes — buildGroupWriteBatch', () => {
  it('shapes a valid engine write-batch envelope', () => {
    const before = emptyGraph();
    const after = addMember(before, BOARD, ref('tab', 't1'), { memberId: 'm1' });
    const req = buildGroupWriteBatch(before, after);
    expect(req.target).toBe(ENGINE_OPERATION_LABEL_TARGET);
    expect(req.payload.operation_label).toBe(ENGINE_WRITE_BATCH_OPERATION);
    expect(req.payload.writes).toHaveLength(1);
    const w = req.payload.writes[0];
    expect(w.address_label).toBe(groupRecordAddress(BOARD));
    expect(w.address_mode).toBe('identity_text');
    expect(w.path_labels).toEqual(['current-item', 'published-record']);
    expect(w.payload).toMatchObject({ groupRef: BOARD, memberOrder: ['m1'] });
  });

  it('add is one write; the same builder handles move with zero special-casing', () => {
    let g = ensureGroup(ensureGroup(emptyGraph(), BOARD), SUB);
    g = addMember(g, BOARD, ref('tab', 't1'), { memberId: 'm1' });
    const after = moveMember(g, 'm1', { fromGroupRef: BOARD, toGroupRef: SUB });
    const req = buildGroupWriteBatch(g, after);
    // both BOARD and SUB changed → two writes, no per-op branch needed
    expect(req.payload.writes.map((w) => w.address_label).sort()).toEqual(
      [groupRecordAddress(BOARD), groupRecordAddress(SUB)].sort(),
    );
  });

  it('ungroup tombstones the dissolved sub-group (status:deleted)', () => {
    let g = emptyGraph();
    for (const i of [1, 2, 3]) g = addMember(g, BOARD, ref('tab', `t${i}`), { memberId: `m${i}` });
    const grouped = groupMembers(g, BOARD, ['m1', 'm2'], SUB, { wrapperMemberId: 'w' });
    const ungrouped = ungroupMembers(grouped, BOARD, 'w');
    const req = buildGroupWriteBatch(grouped, ungrouped);
    const subWrite = req.payload.writes.find((w) => w.address_label === groupRecordAddress(SUB));
    expect(subWrite?.payload.status).toBe('deleted');
  });

  it('a no-op transition produces an empty batch', () => {
    const g = addMember(emptyGraph(), BOARD, ref('tab', 't1'), { memberId: 'm1' });
    expect(buildGroupWriteBatch(g, g).payload.writes).toEqual([]);
  });
});

describe('group-mutation-writes — persistGroupMutation', () => {
  it('dispatches the built batch through the sender', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const before = emptyGraph();
    const after = addMember(before, BOARD, ref('tab', 't1'), { memberId: 'm1' });
    const result = await persistGroupMutation(before, after, send);
    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].payload.writes).toHaveLength(1);
  });

  it('throws without a sender', async () => {
    await expect(persistGroupMutation(emptyGraph(), emptyGraph(), undefined as never)).rejects.toThrow(/sender/);
  });
});
