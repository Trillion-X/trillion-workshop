import { describe, expect, it } from 'vitest';
import { emptyGraph, groupKey, reorderMember } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, placeItems, removeItem, removeItems, moveItem, moveItemToGroup, moveItemsToGroup, patchItems, addMembersVerbatim, setMemberOrder, readItems, type PlaceItemArgs } from './group-board-model';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

/** One fresh, unique paste item (the shape the paste/clone path mints). */
const arg = (i: number): PlaceItemArgs => ({
  memberId: `m${i}`,
  nodeRef: { family: 'test.item', parts: { id: `n${i}` } },
  kind: i % 2 === 0 ? 'note' : 'connector',
  x: i,
  y: i * 2,
  w: 10 + (i % 5),
  h: 20,
  text: `t${i}`,
  extra: i % 3 === 0 ? { x: 999, kind: 'HACK', color: `c${i}` } : { tag: `g${i % 4}` },
});

describe('placeItems — batch item placement (cont.98 batch-47, O(N^2) paste -> O(M+K))', () => {
  it('#1 is SEMANTICALLY IDENTICAL to the K x placeItem fold (the O(N^2) path it replaces), incl. core-wins-over-extra', () => {
    const items = Array.from({ length: 400 }, (_, i) => arg(i));
    const batched = placeItems(emptyGraph(), PARENT, items);
    const folded = items.reduce((g, a) => placeItem(g, PARENT, a), emptyGraph());
    expect(batched).toEqual(folded); // deep-equal: the batch changes complexity, never the result
    // spot-check core-wins: an item whose extra.x/kind tried to override is placed with the AUTHORITATIVE core.
    const byId = new Map(readItems(batched, PARENT).map((it) => [it.memberId, it]));
    expect(byId.get('m0')!.x).toBe(0); // extra.x:999 did NOT win
    expect(byId.get('m0')!.kind).toBe('note'); // extra.kind:'HACK' did NOT win
  });

  it('#2 appends into an EXISTING populated board (base M members + K new), keeping order', () => {
    const base = Array.from({ length: 10 }, (_, i) => arg(i));
    const g0 = placeItems(emptyGraph(), PARENT, base);
    const more = Array.from({ length: 5 }, (_, i) => arg(100 + i));
    const g1 = placeItems(g0, PARENT, more);
    const ids = readItems(g1, PARENT).map((it) => it.memberId);
    expect(ids).toHaveLength(15);
    expect(ids.slice(0, 10)).toEqual(base.map((a) => a.memberId)); // original order preserved
    expect(ids.slice(10)).toEqual(more.map((a) => a.memberId)); // new items appended after
  });

  it('#3 empty / all-skipped batch returns the SAME graph reference (structural no-op)', () => {
    const g = placeItems(emptyGraph(), PARENT, [arg(1), arg(2)]);
    expect(placeItems(g, PARENT, [])).toBe(g); // empty → identical reference
    expect(placeItems(g, PARENT, [arg(1), arg(2)])).toBe(g); // all duplicates → identical reference
  });

  it('#4 SKIPS a duplicate memberId instead of aborting the batch (divergence from placeItem, which throws)', () => {
    const g = placeItems(emptyGraph(), PARENT, [arg(1)]);
    // arg(1) is already present; arg(7) is new → the dup is skipped, the new one still placed.
    const out = placeItems(g, PARENT, [arg(1), arg(7)]);
    const ids = readItems(out, PARENT).map((it) => it.memberId);
    expect(ids).toEqual(['m1', 'm7']); // arg(1) NOT duplicated; arg(7) appended
  });

  it('#5 untouched members keep REFERENCE identity (structural sharing, P1) — only new members are added', () => {
    const g0 = placeItems(emptyGraph(), PARENT, Array.from({ length: 30 }, (_, i) => arg(i)));
    const gk = groupKey(PARENT);
    const before = (g0 as { groups: Record<string, { members: Record<string, unknown> }> }).groups[gk].members;
    const g1 = placeItems(g0, PARENT, [arg(500)]);
    const after = (g1 as { groups: Record<string, { members: Record<string, unknown> }> }).groups[gk].members;
    expect(after.m5).toBe(before.m5); // every pre-existing member shared by reference
    expect(after.m29).toBe(before.m29);
    expect(after.m500).toBeDefined(); // the new member is present
  });

  it('#6 SCALE: placing 20000 items into a 20000-member board completes in ms (the O(N^2) fold would be ~4e8 map-copies)', () => {
    const g0 = placeItems(emptyGraph(), PARENT, Array.from({ length: 20000 }, (_, i) => arg(i)));
    const more = Array.from({ length: 20000 }, (_, i) => arg(1_000_000 + i));
    const g1 = placeItems(g0, PARENT, more);
    const items = readItems(g1, PARENT);
    expect(items).toHaveLength(40000);
    expect(items[39999].memberId).toBe('m1019999'); // appended across the whole batch, O(M+K)
  });
});

describe('removeItems — batch item removal (cont.98 batch-49, O(N^2) delete -> O(M+K))', () => {
  const populate = (n: number) => placeItems(emptyGraph(), PARENT, Array.from({ length: n }, (_, i) => arg(i)));

  it('#1 is SEMANTICALLY IDENTICAL to the K x removeItem fold (the O(N^2) delete it replaces), incl. absent ids', () => {
    const g = populate(300);
    // Delete a mix: present ids (evens up to 200) + some ABSENT ids (removeItem is a no-op for those).
    const ids = [...Array.from({ length: 100 }, (_, i) => `m${i * 2}`), 'GHOST_A', 'GHOST_B'];
    const batched = removeItems(g, PARENT, ids);
    const folded = ids.reduce((acc, id) => removeItem(acc, PARENT, id), g);
    expect(batched).toEqual(folded); // deep-equal: the batch changes complexity, never the result
    expect(readItems(batched, PARENT)).toHaveLength(200); // 100 evens removed from 300
  });

  it('#2 preserves the ORDER of the surviving members', () => {
    const g = populate(6); // m0..m5
    const out = removeItems(g, PARENT, ['m1', 'm3']);
    expect(readItems(out, PARENT).map((i) => i.memberId)).toEqual(['m0', 'm2', 'm4', 'm5']);
  });

  it('#3 empty / all-absent batch returns the SAME graph reference (structural no-op)', () => {
    const g = populate(5);
    expect(removeItems(g, PARENT, [])).toBe(g); // empty → identical reference
    expect(removeItems(g, PARENT, ['nope1', 'nope2'])).toBe(g); // all absent → identical reference
  });

  it('#4 surviving members keep REFERENCE identity (structural sharing, P1)', () => {
    const g = populate(20);
    const gk = groupKey(PARENT);
    const before = (g as { groups: Record<string, { members: Record<string, unknown> }> }).groups[gk].members;
    const out = removeItems(g, PARENT, ['m5']);
    const after = (out as { groups: Record<string, { members: Record<string, unknown> }> }).groups[gk].members;
    expect(after.m5).toBeUndefined(); // removed
    expect(after.m6).toBe(before.m6); // every survivor shared by reference
    expect(after.m19).toBe(before.m19);
  });

  it('#5 SCALE: deleting 10000 from a 20000-member board completes in ms (the O(N^2) fold would be ~2e8 map-copies)', () => {
    const g = populate(20000);
    const ids = Array.from({ length: 10000 }, (_, i) => `m${i}`);
    const out = removeItems(g, PARENT, ids);
    expect(readItems(out, PARENT)).toHaveLength(10000);
  });
});

describe('patchItems as the batch MOVE (cont.98 batch-50: moveItem = patchItem{x,y}) — reposition/arrange/DRAG path', () => {
  const populate = (n: number) => placeItems(emptyGraph(), PARENT, Array.from({ length: n }, (_, i) => arg(i)));

  it('#1 a batch {x,y} patchItems IS the moveItem fold it replaces (the per-frame drag path)', () => {
    const g = populate(300);
    // The exact shape the drag / tidy / arrange sites feed: one {x,y} per selected member.
    const moves = Array.from({ length: 300 }, (_, i) => ({ memberId: `m${i}`, x: i * 3 + 1, y: i * 5 - 2 }));
    const batched = patchItems(g, PARENT, moves.map((m) => ({ memberId: m.memberId, patch: { x: m.x, y: m.y } })));
    const folded = moves.reduce((acc, m) => moveItem(acc, PARENT, m.memberId, m.x, m.y), g);
    expect(batched).toEqual(folded); // deep-equal: the drag/arrange batch changes complexity, never the result
    const byId = new Map(readItems(batched, PARENT).map((it) => [it.memberId, it]));
    expect(byId.get('m10')!.x).toBe(31); // moved to the batch position
    expect(byId.get('m10')!.y).toBe(48);
  });

  it('#2 SCALE: dragging a 5000-member group one frame is O(M+K), not the per-frame O(N^2) fold', () => {
    const g = populate(5000);
    // Simulate ONE pointer-move frame applying a shared delta to all 5000 dragged members.
    const dx = 17, dy = -9;
    const moves = Array.from({ length: 5000 }, (_, i) => ({ memberId: `m${i}`, patch: { x: i + dx, y: i * 2 + dy } }));
    const out = patchItems(g, PARENT, moves);
    const byId = new Map(readItems(out, PARENT).map((it) => [it.memberId, it]));
    expect(byId.get('m4999')!.x).toBe(4999 + dx); // whole group shifted in one O(M+K) frame
  });
});

describe('moveItemsToGroup — batch cross-group move (cont.98 batch-51, O(N^2) move-out -> O(M+K))', () => {
  const SECTION: AddressRef = { family: 'test.section', parts: { sec: 's1' } };
  // A parent board holding a section member, and the section group holding N items.
  const buildNested = (n: number) => {
    let g = placeItems(emptyGraph(), PARENT, [
      { memberId: 'sec', nodeRef: SECTION, kind: 'section', x: 0, y: 0, w: 100, h: 100 },
      { memberId: 'p0', nodeRef: { family: 'test.item', parts: { id: 'p0' } }, kind: 'note', x: 5, y: 5 },
    ]);
    g = placeItems(g, SECTION, Array.from({ length: n }, (_, i) => arg(i))); // m0..m(n-1) live INSIDE the section
    return g;
  };

  it('#1 is SEMANTICALLY IDENTICAL to the K x moveItemToGroup fold (the O(N^2) move-out it replaces), incl. absent ids', () => {
    const g = buildNested(200);
    const ids = [...Array.from({ length: 80 }, (_, i) => `m${i}`), 'GHOST']; // 80 present in section + 1 absent
    const batched = moveItemsToGroup(g, SECTION, PARENT, ids);
    const folded = ids.reduce((acc, id) => moveItemToGroup(acc, SECTION, PARENT, id), g);
    expect(batched).toEqual(folded); // deep-equal: the batch changes complexity, never the result
    // 80 moved OUT of the section (200 - 80 = 120 remain) and INTO the parent (sec + p0 + 80 = 82).
    expect(readItems(batched, SECTION)).toHaveLength(120);
    expect(readItems(batched, PARENT)).toHaveLength(82);
  });

  it('#2 empty / same-group / all-absent batch returns the SAME graph reference', () => {
    const g = buildNested(5);
    expect(moveItemsToGroup(g, SECTION, PARENT, [])).toBe(g); // empty
    expect(moveItemsToGroup(g, SECTION, SECTION, ['m0'])).toBe(g); // same-group is a no-op here
    expect(moveItemsToGroup(g, SECTION, PARENT, ['ghost1', 'ghost2'])).toBe(g); // all absent
  });

  it('#3 untouched members in BOTH groups keep reference identity (structural sharing, P1)', () => {
    const g = buildNested(10);
    const secBefore = (g as { groups: Record<string, { members: Record<string, unknown> }> }).groups[groupKey(SECTION)].members;
    const parBefore = (g as { groups: Record<string, { members: Record<string, unknown> }> }).groups[groupKey(PARENT)].members;
    const out = moveItemsToGroup(g, SECTION, PARENT, ['m0']);
    const secAfter = (out as { groups: Record<string, { members: Record<string, unknown> }> }).groups[groupKey(SECTION)].members;
    const parAfter = (out as { groups: Record<string, { members: Record<string, unknown> }> }).groups[groupKey(PARENT)].members;
    expect(secAfter.m5).toBe(secBefore.m5); // section survivor shared by reference
    expect(parAfter.p0).toBe(parBefore.p0); // dest survivor shared by reference
    expect(parAfter.m0).toBeDefined(); // m0 now lives in the parent
    expect(secAfter.m0).toBeUndefined(); // and no longer in the section
  });

  it('#4 SCALE: moving 10000 items out of a 20000-item section completes in ms (the O(N^2) fold would be ~2e8 map-copies)', () => {
    const g = buildNested(20000);
    const ids = Array.from({ length: 10000 }, (_, i) => `m${i}`);
    const out = moveItemsToGroup(g, SECTION, PARENT, ids);
    expect(readItems(out, SECTION)).toHaveLength(10000); // half remain in the section
    expect(readItems(out, PARENT)).toHaveLength(10002); // sec + p0 + 10000 moved
  });
});

describe('addMembersVerbatim — batch verbatim add (cont.98 batch-55, producer-output O(N^2) -> O(M+K))', () => {
  const verbatim = (i: number) => ({
    memberId: `v${i}`,
    nodeRef: { family: 'test.item', parts: { id: `v${i}` } },
    presentation: { kind: 'note', x: i, y: i, text: `t${i}`, customOpaqueKey: `k${i}` }, // OPAQUE presentation
  });

  it('#1 adds members with presentation VERBATIM (opaque keys preserved, not rebuilt from typed args)', () => {
    const g = addMembersVerbatim(emptyGraph(), PARENT, [verbatim(0), verbatim(1)]);
    const items = readItems(g, PARENT);
    expect(items).toHaveLength(2);
    const byId = new Map(items.map((it) => [it.memberId, it]));
    expect(byId.get('v0')!.text).toBe('t0'); // verbatim presentation landed
    expect((byId.get('v0')!.extra as Record<string, unknown>).customOpaqueKey).toBe('k0'); // OPAQUE key survives
  });

  it('#2 ensures the target group on an empty graph (first producer run lands)', () => {
    const g = addMembersVerbatim(emptyGraph(), PARENT, [verbatim(0)]);
    expect(readItems(g, PARENT)).toHaveLength(1);
  });

  it('#3 SKIPS a duplicate memberId (already present) — no throw, no overwrite', () => {
    const g0 = addMembersVerbatim(emptyGraph(), PARENT, [verbatim(0)]);
    const g1 = addMembersVerbatim(g0, PARENT, [verbatim(0), verbatim(9)]); // v0 dup, v9 new
    expect(readItems(g1, PARENT).map((i) => i.memberId).sort()).toEqual(['v0', 'v9']);
  });

  it('#4 empty / all-skipped batch returns the SAME graph reference (after ensureGroup)', () => {
    const g = addMembersVerbatim(emptyGraph(), PARENT, [verbatim(0)]);
    expect(addMembersVerbatim(g, PARENT, [])).toBe(g); // empty
    expect(addMembersVerbatim(g, PARENT, [verbatim(0)])).toBe(g); // all-dup
  });

  it('#5 SCALE: 20000 verbatim adds complete in ms (the O(N^2) addMember fold would be ~2e8 map-copies)', () => {
    const g = addMembersVerbatim(emptyGraph(), PARENT, Array.from({ length: 20000 }, (_, i) => verbatim(i)));
    expect(readItems(g, PARENT)).toHaveLength(20000);
  });
});

describe('setMemberOrder — batch z-order restack (cont.98 batch-56, O(N^2) reorderMember fold -> O(M+K))', () => {
  /** Build an N-member board directly as an O(N) graph literal (never via a
   *  per-item mutator — that builder is itself O(N^2) and would time out the
   *  scale test; see the batch-46 test-builder gotcha). */
  const build = (n: number) => {
    const memberOrder = Array.from({ length: n }, (_, i) => `m${i}`);
    const members: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) members[`m${i}`] = { memberId: `m${i}`, nodeRef: { family: 'test.item', parts: { id: `n${i}` } }, presentation: { x: i } };
    return { groups: { [groupKey(PARENT)]: { groupRef: PARENT, memberOrder, members } } } as ReturnType<typeof emptyGraph>;
  };
  /** The OLD path: fold the leaf reorderMember to set an exact order (what
   *  reorderZToOrder used to do) — the O(M) per-call fold this batch replaces. */
  const foldToOrder = (g: ReturnType<typeof emptyGraph>, order: readonly string[]) => {
    let next = g;
    for (let i = 1; i < order.length; i++) next = reorderMember(next, PARENT, order[i], { after: order[i - 1] });
    return next;
  };

  it('#1 a FULL permutation is written verbatim — and is IDENTICAL to the old reorderMember fold', () => {
    const g = build(6);
    const order = ['m3', 'm0', 'm5', 'm1', 'm4', 'm2'];
    const out = setMemberOrder(g, PARENT, order);
    expect(readItems(out, PARENT).map((i) => i.memberId)).toEqual(order);
    expect(out).toEqual(foldToOrder(g, order)); // deep-equal: complexity changed, result did not
  });

  it('#2 a partial order is honored, then the OMITTED members are appended in current order (no member dropped)', () => {
    const g = build(5); // m0..m4
    const out = setMemberOrder(g, PARENT, ['m3', 'm1']);
    // m3,m1 first (as given), then the untouched m0,m2,m4 in their existing order.
    expect(readItems(out, PARENT).map((i) => i.memberId)).toEqual(['m3', 'm1', 'm0', 'm2', 'm4']);
  });

  it('#3 SKIPS a stale/foreign id (never in the group) instead of inserting it', () => {
    const g = build(3); // m0,m1,m2
    const out = setMemberOrder(g, PARENT, ['m2', 'ghost', 'm0']);
    expect(readItems(out, PARENT).map((i) => i.memberId)).toEqual(['m2', 'm0', 'm1']); // ghost dropped; m1 appended
  });

  it('#4 DEDUPES a repeated id (keeps first position) — never a double paint entry', () => {
    const g = build(3);
    const out = setMemberOrder(g, PARENT, ['m1', 'm1', 'm0']);
    expect(readItems(out, PARENT).map((i) => i.memberId)).toEqual(['m1', 'm0', 'm2']);
  });

  it('#5 the members MAP is returned by reference — only memberOrder moved (P1 structural sharing)', () => {
    const g = build(4);
    const gk = groupKey(PARENT);
    const out = setMemberOrder(g, PARENT, ['m3', 'm2', 'm1', 'm0']);
    expect(out.groups[gk].members).toBe(g.groups[gk].members); // same object → every node keeps identity
    expect(out.groups[gk].memberOrder).not.toBe(g.groups[gk].memberOrder); // order array is fresh
  });

  it('#6 no-op restack (order unchanged) AND a truly missing group → SAME graph reference (structural no-op)', () => {
    const g = build(4);
    expect(setMemberOrder(g, PARENT, ['m0', 'm1', 'm2', 'm3'])).toBe(g); // order already this → unchanged reference
    const OTHER: AddressRef = { family: 'test.board', parts: { board: 'nope' } };
    expect(setMemberOrder(g, OTHER, ['x'])).toBe(g); // no such group → unchanged reference
  });

  it('#7 SCALE: reverse a 20000-member board in ms — the old reorderMember fold is O(N^2) (~2e8 array copies)', () => {
    const g = build(20000);
    const reversed = Array.from({ length: 20000 }, (_, i) => `m${19999 - i}`);
    const out = setMemberOrder(g, PARENT, reversed);
    const ids = readItems(out, PARENT).map((i) => i.memberId);
    expect(ids).toHaveLength(20000);
    expect(ids[0]).toBe('m19999');
    expect(ids[19999]).toBe('m0');
  });
});
