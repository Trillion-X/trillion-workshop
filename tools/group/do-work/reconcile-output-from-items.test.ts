// packages/group/do-work/reconcile-output-from-items.test.ts
//
// Proves the RECONCILE effect end-to-end at the leaf level: an agent that returns
// the COMPLETE desired board (edit the empty "new note" cards by echoing their ids,
// drop the ones it didn't return, add brand-new ones) reorganizes the real board
// through reconcileOutputFromItems → reconcileBoardGraphAuthoritative. This is the
// core of Sam's ask: "reorganize + fill in the empty notes", not just append.

import { describe, expect, it } from 'vitest';
import { emptyGraph, membersOf, memberById, type AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { applyProducerOutput } from './apply-producer-output';
import { reconcileBoardGraphAuthoritative } from './reconcile-board-producer';
import { reconcileOutputFromItems, type ReconcileItem } from './reconcile-output-from-items';
import type { ProducerOutput } from '../read-data/producer-output';

const board: AddressRef = { family: 'group', parts: { board: 'vision' } };
const itemRef = (id: string): AddressRef => ({ family: 'group', parts: { board: 'vision', item: id } });
const seedOut = (ids: Array<{ id: string; pres: Record<string, unknown> }>): ProducerOutput => ({
  targetGroupRef: board,
  items: ids.map(({ id, pres }) => ({ memberId: id, nodeRef: itemRef(id), presentation: pres })),
});

/** Deterministic id gens (pure test — no crypto). */
function build(items: ReconcileItem[]) {
  let n = 0;
  return reconcileOutputFromItems(items, board, { x: 500, y: 300 }, () => `new-${++n}`, () => itemRef(`node-${n}`));
}

describe('reconcileOutputFromItems (build the reconcile output)', () => {
  it('echoed memberId → edit in place with NO geometry (position preserved)', () => {
    const out = build([{ memberId: 'note-a', kind: 'note', text: 'Run a 5k by June' }]);
    expect(out.items).toHaveLength(1);
    const p = out.items[0].presentation as Record<string, unknown>;
    expect(out.items[0].memberId).toBe('note-a');
    expect(p.text).toBe('Run a 5k by June');
    expect('x' in p).toBe(false); // no geometry → applyProducerOutput keeps the card where it is
    expect('y' in p).toBe(false);
  });

  it('no memberId → a NEW note is minted and grid-placed around the origin', () => {
    const out = build([{ kind: 'note', text: 'Learn to cook 3 dishes' }]);
    expect(out.items[0].memberId).toBe('new-1');
    const p = out.items[0].presentation as Record<string, unknown>;
    expect(typeof p.x).toBe('number');
    expect(typeof p.y).toBe('number');
    expect(p.text).toBe('Learn to cook 3 dishes');
  });

  it('writes extra verbatim and never reads a domain field (L090 blind)', () => {
    const out = build([{ memberId: 'note-a', kind: 'note', extra: { color: 'blue', cluster: 'health' } }]);
    expect(out.items[0].presentation).toMatchObject({ color: 'blue', cluster: 'health' });
  });
});

describe('RECONCILE end-to-end (Sam: reorganize + fill the empty notes)', () => {
  it('edits the empty notes in place, adds new ones, and drops the ones the agent omitted', () => {
    // A board with three empty "new note" cards the user complained about, at real positions.
    const before = applyProducerOutput(
      emptyGraph(),
      seedOut([
        { id: 'n1', pres: { kind: 'note', text: 'new note', x: 10, y: 10 } },
        { id: 'n2', pres: { kind: 'note', text: 'new note', x: 250, y: 10 } },
        { id: 'n3', pres: { kind: 'note', text: 'new note', x: 490, y: 10 } },
      ]),
    );
    // The agent returns the COMPLETE desired board: fill n1 + n2 in place (keep n1/n2 ids),
    // DROP n3 (not returned), and ADD one brand-new goal.
    const output = build([
      { memberId: 'n1', kind: 'note', text: 'Run a 5k without stopping' },
      { memberId: 'n2', kind: 'note', text: 'Read one book a month' },
      { kind: 'note', text: 'Save 3 months of expenses' },
    ]);
    const after = reconcileBoardGraphAuthoritative(before, output);

    const ids = membersOf(after, board).map((m) => m.memberId).sort();
    expect(ids).toEqual(['n1', 'n2', 'new-1']); // n3 dropped, new-1 added
    // n1 edited in place, ORIGINAL position preserved (geometry omitted on edit).
    const p1 = memberById(after, board, 'n1')?.presentation as Record<string, unknown>;
    expect(p1.text).toBe('Run a 5k without stopping');
    expect(p1.x).toBe(10);
    expect(p1.y).toBe(10);
    // the new goal landed with real geometry.
    const pNew = memberById(after, board, 'new-1')?.presentation as Record<string, unknown>;
    expect(pNew.text).toBe('Save 3 months of expenses');
    expect(typeof pNew.x).toBe('number');
  });

  it('an agent that echoes NO ids replaces the whole board (blunt regenerate is still valid)', () => {
    const before = applyProducerOutput(emptyGraph(), seedOut([{ id: 'n1', pres: { kind: 'note', text: 'old', x: 0, y: 0 } }]));
    const output = build([{ kind: 'note', text: 'fresh' }]);
    const after = reconcileBoardGraphAuthoritative(before, output);
    expect(membersOf(after, board).map((m) => m.memberId)).toEqual(['new-1']); // old n1 dropped
  });
});

describe('reconcileOutputFromItems — hallucinated memberId is placed as NEW, never a phantom at (0,0)', () => {
  /** Build WITH the set of ids really on the board (the deployed consume seam supplies this). */
  function buildWithExisting(items: ReconcileItem[], existingIds: Set<string>) {
    let n = 0;
    return reconcileOutputFromItems(
      items, board, { x: 500, y: 300 }, () => `new-${++n}`, () => itemRef(`node-${n}`), existingIds,
    );
  }

  it('an echoed id NOT on the board → minted + grid-placed (has geometry), not an unplaced edit', () => {
    const out = buildWithExisting(
      [{ kind: 'note', text: 'ghost', memberId: 'does-not-exist' }],
      new Set(['n1', 'n2']), // the real board
    );
    const item = out.items[0];
    expect(item.memberId).toBe('new-1'); // a fresh minted id, NOT the hallucinated one
    const p = item.presentation as Record<string, unknown>;
    expect(typeof p.x).toBe('number'); // PLACED — never left at (0,0)/undefined
    expect(typeof p.y).toBe('number');
  });

  it('a REAL echoed id still edits in place (no geometry); mixed real+hallucinated split correctly', () => {
    const out = buildWithExisting(
      [
        { kind: 'note', text: 'kept', memberId: 'n1' },         // real → edit in place
        { kind: 'note', text: 'ghost', memberId: 'zzz' },       // hallucinated → new+placed
        { kind: 'note', text: 'brand new' },                     // genuinely new → new+placed
      ],
      new Set(['n1', 'n2']),
    );
    const [edit, ghost, fresh] = out.items;
    expect(edit.memberId).toBe('n1');
    expect((edit.presentation as Record<string, unknown>).x).toBeUndefined(); // in place
    expect(ghost.memberId).toBe('new-1');
    expect(typeof (ghost.presentation as Record<string, unknown>).x).toBe('number');
    expect(fresh.memberId).toBe('new-2');
    expect(typeof (fresh.presentation as Record<string, unknown>).x).toBe('number');
  });

  it('through reconcileBoardGraphAuthoritative: a hallucinated-id note lands as a real placed card', () => {
    const before = applyProducerOutput(emptyGraph(), seedOut([{ id: 'n1', pres: { kind: 'note', text: 'here', x: 10, y: 10 } }]));
    const out = buildWithExisting(
      [{ kind: 'note', text: 'here', memberId: 'n1' }, { kind: 'note', text: 'ai imagined an id', memberId: 'hallucinated' }],
      new Set(['n1']),
    );
    const after = reconcileBoardGraphAuthoritative(before, out);
    // n1 kept in place; the hallucinated one is a new placed member (not stacked on n1 / not at 0,0).
    expect(membersOf(after, board).map((m) => m.memberId).sort()).toEqual(['n1', 'new-1']);
    const ghost = memberById(after, board, 'new-1')?.presentation as Record<string, unknown>;
    expect(typeof ghost.x).toBe('number');
    expect(ghost.text).toBe('ai imagined an id');
  });

  it('back-compat: with NO existingIds, any echoed memberId edits in place (unchanged shape)', () => {
    const out = build([{ kind: 'note', text: 'x', memberId: 'whatever' }]);
    expect(out.items[0].memberId).toBe('whatever');
    expect((out.items[0].presentation as Record<string, unknown>).x).toBeUndefined();
  });
});
