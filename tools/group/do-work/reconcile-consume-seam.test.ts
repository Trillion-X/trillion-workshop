// packages/group/do-work/reconcile-consume-seam.test.ts
//
// INTEGRATION proof of the Ask-AI reconcile data path the deployed consume seam runs
// (GroupBoardPanel.tsx ~4699). It wires the REAL pieces end to end — no mocks of the
// transformation:
//   raw producer result record  →  itemsFromResult()  (the actual read-producer-status parser)
//                               →  producerItemsToReconcileItems()  (the seam's SSOT mapping)
//                               →  reconcileOutputFromItems()  →  reconcileBoardGraphAuthoritative()
// so a green here means: when the ai-records-producer writes a result the way it really
// does, the board reorganizes exactly as intended. The only unmocked-away piece is the
// React useEffect glue (which just calls this chain and commits the result).

import { describe, expect, it } from 'vitest';
import { emptyGraph, membersOf, memberById, type AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { applyProducerOutput } from './apply-producer-output';
import { reconcileBoardGraphAuthoritative } from './reconcile-board-producer';
import { reconcileOutputFromItems, producerItemsToReconcileItems } from './reconcile-output-from-items';
import { itemsFromResult } from '../read-data/read-producer-status';
import type { ProducerOutput } from '../read-data/producer-output';

const board: AddressRef = { family: 'group', parts: { board: 'vision' } };
const itemRef = (id: string): AddressRef => ({ family: 'group', parts: { board: 'vision', item: id } });
const seed = (ids: Array<{ id: string; pres: Record<string, unknown> }>): ProducerOutput => ({
  targetGroupRef: board,
  items: ids.map(({ id, pres }) => ({ memberId: id, nodeRef: itemRef(id), presentation: pres })),
});

/** The full deployed chain (minus the React commit) as one call — exactly what the seam does. */
function reconcileFromRawResult(before: ReturnType<typeof emptyGraph>, rawResult: { items?: unknown }) {
  const items = itemsFromResult(rawResult.items); // REAL parser (untrusted-cap, field validation) — readProducerStatus calls itemsFromResult(result.items)
  expect(items).toBeTruthy();
  let n = 0;
  const output = reconcileOutputFromItems(
    producerItemsToReconcileItems(items!),
    board,
    { x: 500, y: 300 },
    () => `new-${++n}`,
    () => itemRef(`node-${n}`),
  );
  return reconcileBoardGraphAuthoritative(before, output);
}

describe('Ask AI reconcile — real producer result → board reorganize (Flavor A, regenerate)', () => {
  it('a note-array result (no ids) REPLACES the board with the agent set (the "make it a good example" run)', () => {
    // Sam's board: 3 empty "new note" cards + a real one.
    const before = applyProducerOutput(emptyGraph(), seed([
      { id: 'n1', pres: { kind: 'note', text: 'new note', x: 10, y: 10 } },
      { id: 'n2', pres: { kind: 'note', text: 'new note', x: 250, y: 10 } },
      { id: 'n3', pres: { kind: 'note', text: 'Learn guitar', x: 490, y: 10 } },
    ]));
    // What ai-records-producer writes for output_kind:'note' from the agent's JSON array.
    const rawResult = { items: [
      { kind: 'note', text: 'Run a 5k without stopping by June' },
      { kind: 'note', text: 'Read one book every month' },
      { kind: 'note', text: 'Learn 3 guitar songs' },
      { kind: 'note', text: 'Save 3 months of expenses' },
    ] };
    const after = reconcileFromRawResult(before, rawResult);
    const texts = membersOf(after, board).map((m) => (m.presentation as Record<string, unknown>).text).sort();
    // Old empty notes gone; board is now exactly the agent's 4 improved goals.
    expect(membersOf(after, board)).toHaveLength(4);
    expect(texts).toEqual(['Learn 3 guitar songs', 'Read one book every month', 'Run a 5k without stopping by June', 'Save 3 months of expenses']);
    // Every landed note has real geometry (laid out, not stacked at 0,0).
    for (const m of membersOf(after, board)) {
      const p = m.presentation as Record<string, unknown>;
      expect(typeof p.x).toBe('number');
      expect(typeof p.y).toBe('number');
    }
  });
});

describe('Ask AI reconcile — Flavor B forward-compat (agent echoes ids → edit in place)', () => {
  it('when the result items carry memberIds, existing cards edit in place (position kept) and omitted drop', () => {
    const before = applyProducerOutput(emptyGraph(), seed([
      { id: 'n1', pres: { kind: 'note', text: 'new note', x: 10, y: 10 } },
      { id: 'n2', pres: { kind: 'note', text: 'new note', x: 250, y: 10 } },
      { id: 'n3', pres: { kind: 'note', text: 'stale', x: 490, y: 10 } },
    ]));
    // itemsFromResult preserves memberId (verified below) — the round-trip that Flavor B needs.
    const rawResult = { items: [
      { kind: 'note', text: 'Run a 5k without stopping', memberId: 'n1' },
      { kind: 'note', text: 'Read one book a month', memberId: 'n2' },
      { kind: 'note', text: 'Save 3 months of expenses' }, // new
    ] };
    const after = reconcileFromRawResult(before, rawResult);
    expect(membersOf(after, board).map((m) => m.memberId).sort()).toEqual(['n1', 'n2', 'new-1']);
    const p1 = memberById(after, board, 'n1')?.presentation as Record<string, unknown>;
    expect(p1.text).toBe('Run a 5k without stopping');
    expect(p1.x).toBe(10); // position preserved on edit-in-place
    expect(p1.y).toBe(10);
  });

  it('itemsFromResult surfaces an echoed memberId (the field Flavor B depends on)', () => {
    const items = itemsFromResult([{ kind: 'note', text: 'x', memberId: 'n1' }]);
    expect(items?.[0].memberId).toBe('n1');
  });
});
