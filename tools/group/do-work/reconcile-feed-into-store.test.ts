// packages/group/do-work/reconcile-feed-into-store.test.ts
//
// End-to-end integration of the feed->board pipeline against a FAKE store: feed
// records land as members, a departed record is removed, a dragged position is
// preserved across a reconcile, and an unchanged feed writes nothing.

import { describe, expect, it } from 'vitest';
import { emptyGraph, membersOf, memberById, type GroupGraph, type AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { reconcileFeedIntoStore, seedNewMemberPositions } from './reconcile-feed-into-store';
import { applyProducerOutput } from './apply-producer-output';
import type { GroupBoardStore } from '../read-data/read-group-board';
import type { FeedBoardProjectionConfig } from '../read-data/feed-board-projection';

const board: AddressRef = { family: 'group.board', parts: { board: 'company' } };

const CONFIG: FeedBoardProjectionConfig = {
  cardSurface: { packageName: 'ai-agent-profile', entryName: 'agent-card' },
  idField: 'id',
  surfaceInputKey: 'agentId',
  groupKeyField: 'department',
  statusField: 'status',
  kindFilter: 'ai-agent-profile',
};

const rec = (payload: unknown) => ({ payload });

/** A fake store backed by an in-memory graph — records apply() calls for asserting. */
function fakeStore(initial: GroupGraph = emptyGraph()) {
  let graph = initial;
  let applies = 0;
  const store: GroupBoardStore = {
    load: async () => graph,
    apply: async (_before, after) => {
      graph = after;
      applies += 1;
    },
  };
  return {
    store,
    get graph() {
      return graph;
    },
    get applies() {
      return applies;
    },
  };
}

const agent = (id: string, over: Record<string, unknown> = {}) => rec({ kind: 'ai-agent-profile', id, ...over });

describe('reconcileFeedIntoStore — end-to-end pipeline over a fake store', () => {
  it('materializes feed records as board members', async () => {
    const s = fakeStore();
    const res = await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Growth' }), agent('b')], board, CONFIG);
    expect(res.changed).toBe(true);
    expect(res.memberCount).toBe(2);
    expect(membersOf(s.graph, board).map((m) => m.memberId).sort()).toEqual(['a', 'b']);
    // pointer landed
    const m = memberById(s.graph, board, 'a');
    expect((m?.presentation as any).placeableSurface.surfaceInput).toEqual({ agentId: 'a' });
  });

  it('reports membershipChanged only on add/remove, NOT on a field-only tick (the reload-churn fix)', async () => {
    const s = fakeStore();
    const first = await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops' })], board, CONFIG);
    expect(first.membershipChanged).toBe(true); // 'a' is new
    expect(first.addedCount).toBe(1);
    // same membership, a field (status) changes → the projection no longer mirrors
    // status, so this is a pure no-op: membershipChanged false, changed false.
    const fieldTick = await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops', status: 'busy' })], board, CONFIG);
    expect(fieldTick.membershipChanged).toBe(false);
    // a genuinely new worker → membershipChanged true again
    const grow = await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops' }), agent('b')], board, CONFIG);
    expect(grow.membershipChanged).toBe(true);
    expect(grow.addedCount).toBe(1);
    // a worker leaves → membershipChanged true
    const shrink = await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops' })], board, CONFIG);
    expect(shrink.membershipChanged).toBe(true);
    expect(shrink.removedCount).toBe(1);
  });

  it('removes a member whose record left the feed (churn)', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a'), agent('b')], board, CONFIG);
    const res = await reconcileFeedIntoStore(s.store, [agent('a')], board, CONFIG);
    expect(res.removedCount).toBe(1);
    expect(membersOf(s.graph, board).map((m) => m.memberId)).toEqual(['a']);
  });

  it('PRESERVES a dragged position across a reconcile (merge omits x/y)', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops' })], board, CONFIG);
    // simulate a user drag: move member a to (500,400)
    s.store.apply(await s.store.load(), applyProducerOutput(await s.store.load(), {
      targetGroupRef: board,
      items: [{ memberId: 'a', nodeRef: { family: 'x', parts: { item: 'a' } }, presentation: { x: 500, y: 400 } }],
    }));
    // reconcile again with a status change — position must survive
    const res = await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops', status: 'idle' })], board, CONFIG);
    const p = memberById(s.graph, board, 'a')?.presentation as Record<string, unknown>;
    expect(p.x).toBe(500);
    expect(p.y).toBe(400);
    expect((p as any).status).toBe('idle');
    expect(res.changed).toBe(true);
  });

  it('an UNCHANGED feed writes nothing (changed:false, apply not called again)', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a'), agent('b')], board, CONFIG);
    const appliesAfterFirst = s.applies;
    const res = await reconcileFeedIntoStore(s.store, [agent('a'), agent('b')], board, CONFIG);
    expect(res.changed).toBe(false);
    expect(s.applies).toBe(appliesAfterFirst); // no extra write
  });

  it('an empty feed clears the board', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a')], board, CONFIG);
    const res = await reconcileFeedIntoStore(s.store, [], board, CONFIG);
    expect(res.removedCount).toBe(1);
    expect(membersOf(s.graph, board)).toHaveLength(0);
  });

  it('a NON-AUTHORITATIVE empty feed (feed not yet delivered) NEVER wipes a populated board (L117 — loading must not destroy data)', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a'), agent('b')], board, CONFIG);
    // A fresh client mounts: useBitfieldData is still null → records []; the mount
    // passes authoritative:false. The 2 existing members must SURVIVE.
    const res = await reconcileFeedIntoStore(s.store, [], board, CONFIG, { authoritative: false });
    expect(res.removedCount).toBe(0);
    expect(membersOf(s.graph, board).map((m) => m.memberId).sort()).toEqual(['a', 'b']);
    expect(res.changed).toBe(false); // nothing added, nothing removed → no write
  });

  it('a NON-AUTHORITATIVE feed still UPSERTS present members (additive-only, never subtractive)', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a')], board, CONFIG);
    // feed briefly delivers only b while flagged non-authoritative: b is ADDED, a is KEPT.
    const res = await reconcileFeedIntoStore(s.store, [agent('b')], board, CONFIG, { authoritative: false });
    expect(res.removedCount).toBe(0);
    expect(membersOf(s.graph, board).map((m) => m.memberId).sort()).toEqual(['a', 'b']);
  });

  it('once the feed DELIVERS (authoritative:true, the default), a genuine empty clears the board', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a')], board, CONFIG);
    const res = await reconcileFeedIntoStore(s.store, [], board, CONFIG, { authoritative: true });
    expect(res.removedCount).toBe(1);
    expect(membersOf(s.graph, board)).toHaveLength(0);
  });

  it('stores the CANONICAL FLAT presentation: readPlaceableSurface-visible pointer, kind at top level (the FallbackItem regression)', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops', status: 'available' })], board, CONFIG);
    const p = memberById(s.graph, board, 'a')?.presentation as Record<string, unknown>;
    // FLAT: pointer/cluster/tone sit beside kind — the shape readItems copies into
    // BoardItem.extra and readPlaceableSurface resolves. No nested extra sub-object.
    expect(p.kind).toBe('placeable-surface');
    expect((p.placeableSurface as any).packageName).toBe('ai-agent-profile');
    expect(p.groupKey).toBe('Ops');
    expect(p.status).toBe('available');
    expect('extra' in p).toBe(false);
  });

  it('SEEDS clustered x/y/w/h on NEW members (no 0,0 pile-up); different departments land in different clusters', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(
      s.store,
      [agent('a', { department: 'Growth' }), agent('b', { department: 'Growth' }), agent('c', { department: 'Ops' })],
      board,
      CONFIG,
    );
    const pa = memberById(s.graph, board, 'a')?.presentation as Record<string, unknown>;
    const pb = memberById(s.graph, board, 'b')?.presentation as Record<string, unknown>;
    const pc = memberById(s.graph, board, 'c')?.presentation as Record<string, unknown>;
    // every new member has real geometry
    for (const p of [pa, pb, pc]) {
      expect(typeof p.x).toBe('number');
      expect(typeof p.y).toBe('number');
      expect(p.w).toBe(380);
      expect(p.h).toBe(300);
    }
    // no two members share a position (the 0,0 stack is structurally gone)
    const keys = [pa, pb, pc].map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(3);
    // same-department members share a cluster row-space; the other department is offset
    expect(pa.y).not.toBe(pc.y);
  });

  it('a LATER reconcile never reseeds an existing member (drag survives; only NEW ids get geometry)', async () => {
    const s = fakeStore();
    await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops' })], board, CONFIG);
    // user drags a to (777, 555)
    await s.store.apply(await s.store.load(), applyProducerOutput(await s.store.load(), {
      targetGroupRef: board,
      items: [{ memberId: 'a', nodeRef: { family: 'x', parts: { item: 'a' } }, presentation: { x: 777, y: 555 } }],
    }));
    // a NEW agent joins — a must stay at its dragged spot, b gets a seed
    await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops' }), agent('b', { department: 'Ops' })], board, CONFIG);
    const pa = memberById(s.graph, board, 'a')?.presentation as Record<string, unknown>;
    const pb = memberById(s.graph, board, 'b')?.presentation as Record<string, unknown>;
    expect(pa.x).toBe(777);
    expect(pa.y).toBe(555);
    expect(typeof pb.x).toBe('number');
    expect(`${pb.x},${pb.y}`).not.toBe('777,555');
  });

  it('HEALS a member stored by the pre-fix NESTED encoding: first merge deletes the stale extra sub-object and lands the flat pointer', async () => {
    const s = fakeStore();
    // simulate the legacy write: nested extra, no top-level pointer (the broken live shape)
    await s.store.apply(await s.store.load(), applyProducerOutput(await s.store.load(), {
      targetGroupRef: board,
      items: [{
        memberId: 'a',
        nodeRef: { family: 'group.feed-item', parts: { item: 'a' } },
        presentation: {
          kind: 'placeable-surface',
          groupKey: 'Ops',
          extra: { groupKey: 'Ops', placeableSurface: { packageName: 'ai-agent-profile', entryName: 'agent-card', surfaceInput: { agentId: 'a' } } },
        } as any,
      }],
    }));
    await reconcileFeedIntoStore(s.store, [agent('a', { department: 'Ops' })], board, CONFIG);
    const p = memberById(s.graph, board, 'a')?.presentation as Record<string, unknown>;
    expect('extra' in p).toBe(false); // stale nested blob pruned by the undefined-key merge
    expect((p.placeableSurface as any).entryName).toBe('agent-card'); // flat pointer landed
  });
});
