// packages/group/do-work/group-membership-actions.test.ts
//
// T1 test contract (plan §8): every op through the ONE generic executor, plus
// the §4 adversarial gate's hostile compositions asserted as write-sets.

import { describe, expect, it } from 'vitest';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { emptyGraph, membersOf } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { groupRecordAddress } from '../read-data/group-eeaf';
import { buildGroupWriteBatch } from './group-mutation-writes';
import { applyGroupOp, applyGroupMutationTarget, loadGroupGraphTarget, opRoots, runGroupMutation, type GroupMutationOp } from './group-membership-actions';

const ref = (id: string): AddressRef => ({ family: 'placeable-surface', parts: { id } });
const list = (id: string): AddressRef => ({ family: 'group.collection', parts: { id } });

const op = (partial: Partial<GroupMutationOp> & { kind: string; groupRef: AddressRef }): GroupMutationOp =>
  partial as GroupMutationOp;

describe('applyGroupOp — every capability through the one executor', () => {
  it('ensure-group creates, add/remove/reorder/set-member-fields round-trip', () => {
    let g = applyGroupOp(emptyGraph(), op({ kind: 'ensure-group', groupRef: list('a') }));
    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1' }));
    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s2'), memberId: 'm2' }));
    g = applyGroupOp(g, op({
      kind: 'set-member-fields', groupRef: list('a'), memberId: 'm1',
      presentation: { icon: 'star' },
    }));
    g = applyGroupOp(g, op({ kind: 'reorder-member', groupRef: list('a'), memberId: 'm2', placement: { at: 'start' } }));
    expect(membersOf(g, list('a')).map((m) => m.memberId)).toEqual(['m2', 'm1']);
    expect(membersOf(g, list('a'))[1].presentation).toEqual({ icon: 'star' });
    g = applyGroupOp(g, op({ kind: 'remove-member', groupRef: list('a'), memberId: 'm2' }));
    expect(membersOf(g, list('a')).map((m) => m.memberId)).toEqual(['m1']);
  });

  it('patches presentation against the current member without erasing another edit', () => {
    let graph = applyGroupOp(emptyGraph(), op({
      kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1',
      presentation: { name: 'Current name', tint: 'blue' },
    }));
    graph = applyGroupOp(graph, op({
      kind: 'patch-member-presentation', groupRef: list('a'), memberId: 'm1',
      presentation: { placement: { position: 'right' } },
    }));
    expect(membersOf(graph, list('a'))[0].presentation).toEqual({
      name: 'Current name', tint: 'blue', placement: { position: 'right' },
    });
  });

  it('move-member between lists preserves fields; group/ungroup round-trips', () => {
    let g = emptyGraph();
    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1', presentation: { tint: 'blue' } }));
    g = applyGroupOp(g, op({ kind: 'ensure-group', groupRef: list('b') }));
    g = applyGroupOp(g, op({ kind: 'move-member', groupRef: list('a'), toGroupRef: list('b'), memberId: 'm1' }));
    expect(membersOf(g, list('a'))).toHaveLength(0);
    expect(membersOf(g, list('b'))[0].presentation).toEqual({ tint: 'blue' });

    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('b'), nodeRef: ref('s2'), memberId: 'm2' }));
    g = applyGroupOp(g, op({
      kind: 'group-members', groupRef: list('b'), memberIds: ['m1', 'm2'],
      toGroupRef: list('sub'), wrapperMemberId: 'w1',
    }));
    expect(membersOf(g, list('b')).map((m) => m.memberId)).toEqual(['w1']);
    expect(membersOf(g, list('sub')).map((m) => m.memberId)).toEqual(['m1', 'm2']);
    g = applyGroupOp(g, op({ kind: 'ungroup-members', groupRef: list('b'), wrapperMemberId: 'w1' }));
    expect(membersOf(g, list('b')).map((m) => m.memberId)).toEqual(['m1', 'm2']);
    expect(membersOf(g, list('sub'))).toHaveLength(0);
  });

  it('unknown kind fails closed', () => {
    expect(() => applyGroupOp(emptyGraph(), op({ kind: 'nope', groupRef: list('a') }))).toThrow(/unknown group mutation kind/);
  });

  it('missing required field names the field and the kind', () => {
    expect(() => applyGroupOp(emptyGraph(), op({ kind: 'add-member', groupRef: list('a') }))).toThrow(/'nodeRef'/);
  });
});

describe('§4 adversarial gate compositions as write-sets', () => {
  it('multi-membership: same surface in two lists — two independent rows', () => {
    let g = emptyGraph();
    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'a1' }));
    const before = g;
    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('b'), nodeRef: ref('s1'), memberId: 'b1' }));
    const { payload } = buildGroupWriteBatch(before, g);
    // Only list b changed — O(changed), list a untouched.
    expect(payload.writes).toHaveLength(1);
    expect(payload.writes[0].address_label).toBe(groupRecordAddress(list('b')));
  });

  it('nesting N deep works; cycle is rejected at any depth', () => {
    let g = emptyGraph();
    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('root'), nodeRef: list('mid'), memberId: 'w-mid' }));
    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('mid'), nodeRef: list('deep'), memberId: 'w-deep' }));
    expect(() =>
      applyGroupOp(g, op({ kind: 'add-member', groupRef: list('deep'), nodeRef: list('root'), memberId: 'boom' })),
    ).toThrow(/cycle/);
  });

  it('delete then recreate are ordinary writes: tombstone then upsert', () => {
    let g = emptyGraph();
    g = applyGroupOp(g, op({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1' }));
    const alive = g;
    const deleted = applyGroupOp(g, op({ kind: 'delete-group', groupRef: list('a') }));
    const del = buildGroupWriteBatch(alive, deleted);
    expect(del.payload.writes).toHaveLength(1);
    expect(del.payload.writes[0].payload.status).toBe('deleted');
    const recreated = applyGroupOp(deleted, op({ kind: 'ensure-group', groupRef: list('a') }));
    const rec = buildGroupWriteBatch(deleted, recreated);
    expect(rec.payload.writes).toHaveLength(1);
    expect(rec.payload.writes[0].payload.status).toBeUndefined();
  });

  it('no-op transition emits zero writes', () => {
    let g = emptyGraph();
    g = applyGroupOp(g, op({ kind: 'ensure-group', groupRef: list('a') }));
    const again = applyGroupOp(g, op({ kind: 'ensure-group', groupRef: list('a') }));
    expect(buildGroupWriteBatch(g, again).payload.writes).toHaveLength(0);
    const rm = applyGroupOp(g, op({ kind: 'remove-member', groupRef: list('a'), memberId: 'ghost' }));
    expect(buildGroupWriteBatch(g, rm).payload.writes).toHaveLength(0);
  });
});

describe('runGroupMutation — live sequencing through an injected sender', () => {
  it('refuses an unnamed store before reading or writing', async () => {
    let calls = 0;
    await expect(runGroupMutation(op({ kind: 'ensure-group', groupRef: list('fresh') }), {
      sender: async () => { calls += 1; return {}; },
    })).rejects.toThrow('no trusted partition label');
    expect(calls).toBe(0);
    expect(await loadGroupGraphTarget({ roots: [list('fresh')] })).toMatchObject({ ok: false, graph: null });
    expect(await applyGroupMutationTarget(op({ kind: 'ensure-group', groupRef: list('fresh') }))).toMatchObject({ ok: false, writes: 0 });
  });
  // Engine read-current wire replies (decodeEngineReadCurrentReply contract):
  // not-found = [0]; found = [1, 1, u32le payloadLength, ...payloadBytes].
  const NOT_FOUND = new Uint8Array([0]);
  function foundReply(value: unknown): Uint8Array {
    const payload = new TextEncoder().encode(JSON.stringify(value));
    const out = new Uint8Array(6 + payload.byteLength);
    out[0] = 1;
    out[1] = 1;
    new DataView(out.buffer).setUint32(2, payload.byteLength, true);
    out.set(payload, 6);
    return out;
  }

  // In-memory "engine": binary requests are read-currents (served from the
  // store), object requests are write-batches (applied to the store).
  function makeEngine(seed: Record<string, unknown> = {}) {
    const stored = new Map<string, unknown>(Object.entries(seed));
    const writeBatches: Array<{ address_label: string; payload: Record<string, unknown> }> = [];
    const sender = async (request: { target: string; payload: unknown }): Promise<unknown> => {
      if (request.payload instanceof Uint8Array) {
        // The read request embeds the identity-text address bytes verbatim.
        const text = new TextDecoder().decode(request.payload);
        for (const [address, value] of stored) {
          if (text.includes(address)) return foundReply(value);
        }
        return NOT_FOUND;
      }
      const writes = (request.payload as { writes: Array<{ address_label: string; payload: Record<string, unknown> }> }).writes;
      for (const w of writes) {
        stored.set(w.address_label, w.payload);
        writeBatches.push(w);
      }
      return { ok: true, count: writes.length };
    };
    return { stored, writeBatches, sender };
  }

  it('opRoots includes group, node, and destination refs', () => {
    expect(opRoots(op({ kind: 'move-member', groupRef: list('a'), toGroupRef: list('b'), memberId: 'm' }))).toHaveLength(2);
    expect(opRoots(op({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm' }))).toHaveLength(2);
  });

  it('creates a fresh collection: read misses → op → one write', async () => {
    const engine = makeEngine();
    const result = await runGroupMutation(
      op({ kind: 'ensure-group', groupRef: list('fresh') }),
      { partitionLabel: 'test', sender: engine.sender },
    );
    expect(result.batch.payload.writes).toHaveLength(1);
    expect(result.reply).toEqual({ ok: true, count: 1 });
    expect(engine.stored.has(groupRecordAddress(list('fresh')))).toBe(true);
  });

  it('edits an EXISTING collection read back from the engine', async () => {
    const engine = makeEngine();
    await runGroupMutation(op({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s1'), memberId: 'm1' }), {
      partitionLabel: 'test', sender: engine.sender,
    });
    await runGroupMutation(op({ kind: 'add-member', groupRef: list('a'), nodeRef: ref('s2'), memberId: 'm2' }), {
      partitionLabel: 'test', sender: engine.sender,
    });
    const record = engine.stored.get(groupRecordAddress(list('a'))) as { memberOrder: string[] };
    expect(record.memberOrder).toEqual(['m1', 'm2']);
  });

  it('no-op mutation sends zero writes (reply null)', async () => {
    const engine = makeEngine();
    await runGroupMutation(op({ kind: 'ensure-group', groupRef: list('a') }), { partitionLabel: 'test', sender: engine.sender });
    const result = await runGroupMutation(op({ kind: 'ensure-group', groupRef: list('a') }), {
      partitionLabel: 'test', sender: engine.sender,
    });
    expect(result.batch.payload.writes).toHaveLength(0);
    expect(result.reply).toBeNull();
  });

  it('cross-graph cycle is caught because opRoots loads BOTH subtrees', async () => {
    const engine = makeEngine();
    await runGroupMutation(op({ kind: 'add-member', groupRef: list('outer'), nodeRef: list('inner'), memberId: 'w' }), {
      partitionLabel: 'test', sender: engine.sender,
    });
    await expect(
      runGroupMutation(op({ kind: 'add-member', groupRef: list('inner'), nodeRef: list('outer'), memberId: 'boom' }), {
        partitionLabel: 'test', sender: engine.sender,
      }),
    ).rejects.toThrow(/cycle/);
  });
});
