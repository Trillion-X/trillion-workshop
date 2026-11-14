// packages/group/do-work/apply-producer-output.test.ts
//
// The producer→group bridge: ONE seam every producer reuses. Proves insert (a
// new item lands), merge (a generation result fills src on its pending item),
// empty (no-op), blindness (an unknown kind/extra is written verbatim, never
// branched), and that the result flows through the EXISTING write-batch diff —
// so a producer fill becomes real persistence with zero new write path.

import { describe, expect, it } from 'vitest';
import { emptyGraph, memberById, membersOf, type AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { applyProducerOutput } from './apply-producer-output';
import { buildGroupWriteBatch } from './group-mutation-writes';
import type { ProducerOutput } from '../read-data/producer-output';

const board: AddressRef = { family: 'group', parts: { board: 'vision-board' } };
const itemRef = (id: string): AddressRef => ({ family: 'group', parts: { board: 'vision-board', item: id } });

describe('applyProducerOutput — the producer→group write bridge', () => {
  it('INSERTS a new member for an item the group has never seen (agent/source pull)', () => {
    const out: ProducerOutput = {
      targetGroupRef: board,
      items: [{ memberId: 'a', nodeRef: itemRef('a'), presentation: { kind: 'image', x: 10, y: 20, src: '/cas/x' } }],
    };
    const next = applyProducerOutput(emptyGraph(), out);
    const m = memberById(next, board, 'a');
    expect(m?.presentation).toEqual({ kind: 'image', x: 10, y: 20, src: '/cas/x' });
  });

  it('MERGES presentation onto an existing member (a generation result fills src) — legacy nested extra is FLATTENED by the codec', () => {
    const pending = applyProducerOutput(emptyGraph(), {
      targetGroupRef: board,
      items: [{ memberId: 'g1', nodeRef: itemRef('g1'), presentation: { kind: 'generated', x: 0, y: 0, extra: { status: 'pending' } } }],
    });
    const done = applyProducerOutput(pending, {
      targetGroupRef: board,
      items: [{ memberId: 'g1', nodeRef: itemRef('g1'), presentation: { src: '/cas/done', extra: { status: 'done' } } }],
    });
    const m = memberById(done, board, 'g1');
    // kind+x+y preserved from the pending placement; src merged in; the nested
    // `extra.status` is FLATTENED to a top-level status by normalizeProducerPresentation
    // (the ONE stored encoding — incident 2026-07-11), and no `extra` key survives.
    expect(m?.presentation).toEqual({ kind: 'generated', x: 0, y: 0, src: '/cas/done', status: 'done' });
    expect(membersOf(done, board)).toHaveLength(1); // merged, not duplicated
  });

  it('writes an UNKNOWN kind + arbitrary extra VERBATIM (blind — L090, no branch)', () => {
    const next = applyProducerOutput(emptyGraph(), {
      targetGroupRef: board,
      items: [{ memberId: 'z', nodeRef: itemRef('z'), presentation: { kind: 'pinterest-pin-invented-tomorrow', mood: 'calm', x: 1, y: 2 } }],
    });
    expect(memberById(next, board, 'z')?.presentation).toEqual({ kind: 'pinterest-pin-invented-tomorrow', mood: 'calm', x: 1, y: 2 });
  });

  it('an EMPTY envelope is a no-op (a producer that found nothing)', () => {
    const next = applyProducerOutput(emptyGraph(), { targetGroupRef: board, items: [] });
    expect(membersOf(next, board)).toHaveLength(0);
  });

  it('materializes MANY items in one run (an agent placing a whole mood-board)', () => {
    const next = applyProducerOutput(emptyGraph(), {
      targetGroupRef: board,
      items: [
        { memberId: 'a', nodeRef: itemRef('a'), presentation: { kind: 'image', x: 0, y: 0 } },
        { memberId: 'b', nodeRef: itemRef('b'), presentation: { kind: 'note', x: 5, y: 5, text: 'vibe' } },
        { memberId: 'c', nodeRef: itemRef('c'), presentation: { kind: 'media', x: 9, y: 9, src: '/cas/v' } },
      ],
    });
    expect(membersOf(next, board).map((m) => m.memberId)).toEqual(['a', 'b', 'c']);
  });

  it('the bridge result flows through the EXISTING write-batch diff (real persistence)', () => {
    const before = emptyGraph();
    const after = applyProducerOutput(before, {
      targetGroupRef: board,
      items: [{ memberId: 'a', nodeRef: itemRef('a'), presentation: { kind: 'image', x: 0, y: 0, src: '/cas/x' } }],
    });
    const batch = buildGroupWriteBatch(before, after);
    expect(batch.payload.writes.length).toBeGreaterThan(0); // the new board group is written
    expect(batch.payload.operation_label).toBe('engine.operation.write-batch');
  });
});
