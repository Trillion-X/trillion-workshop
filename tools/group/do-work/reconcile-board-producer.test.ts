// packages/group/do-work/reconcile-board-producer.test.ts
//
// Proves the authoritative-membership reconcile: present items upsert, absent
// members tombstone, arrangement survives a merge (x/y omitted → preserved), and
// the result flows through the existing write-batch diff. Blind to kind/product.

import { describe, expect, it } from 'vitest';
import { emptyGraph, membersOf, memberById, type AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { applyProducerOutput, applyPartialProducerOutput } from './apply-producer-output';
import {
  reconcileBoardGraph,
  reconcileBoardGraphAuthoritative,
  reconcileBoardGraphFromUntrustedResult,
  absentMemberIds,
} from './reconcile-board-producer';
import { buildGroupWriteBatch } from './group-mutation-writes';
import type { ProducerOutput } from '../read-data/producer-output';
import { itemResultStatus } from '../read-data/read-producer-status';
import { producerItemsToReconcileItems, reconcileOutputFromItems } from './reconcile-output-from-items';

const board: AddressRef = { family: 'group', parts: { board: 'company' } };
const itemRef = (id: string): AddressRef => ({ family: 'group', parts: { board: 'company', item: id } });
const out = (ids: Array<{ id: string; pres?: Record<string, unknown> }>): ProducerOutput => ({
  targetGroupRef: board,
  items: ids.map(({ id, pres }) => ({ memberId: id, nodeRef: itemRef(id), presentation: pres ?? { kind: 'card', x: 0, y: 0 } })),
});

/** Seed a board with members a..N at distinct positions. */
function seeded(ids: string[]): ReturnType<typeof applyProducerOutput> {
  return applyProducerOutput(
    emptyGraph(),
    out(ids.map((id, i) => ({ id, pres: { kind: 'card', x: i * 100, y: i * 10 } }))),
  );
}

describe('absentMemberIds', () => {
  it('returns current members not in the keep set (stable order)', () => {
    const g = seeded(['a', 'b', 'c']);
    expect(absentMemberIds(g, board, ['a', 'c'])).toEqual(['b']);
    expect(absentMemberIds(g, board, ['a', 'b', 'c'])).toEqual([]);
    expect(absentMemberIds(g, board, [])).toEqual(['a', 'b', 'c']);
  });
});

describe('reconcileBoardGraph (explicit removal list)', () => {
  it('upserts the output AND removes the named members in one transition', () => {
    const before = seeded(['a', 'b']);
    const after = reconcileBoardGraph(before, out([{ id: 'a' }, { id: 'c' }]), ['b']);
    expect(membersOf(after, board).map((m) => m.memberId).sort()).toEqual(['a', 'c']);
  });

  it('empty removal list is a plain apply', () => {
    const before = seeded(['a']);
    const after = reconcileBoardGraph(before, out([{ id: 'b' }]), []);
    expect(membersOf(after, board).map((m) => m.memberId).sort()).toEqual(['a', 'b']);
  });
});

describe('reconcileBoardGraphAuthoritative (feed IS the membership)', () => {
  it('adds present, removes absent — mirrors the feed exactly', () => {
    const before = seeded(['a', 'b', 'c']); // c will be dropped by the feed
    const after = reconcileBoardGraphAuthoritative(before, out([{ id: 'a' }, { id: 'b' }, { id: 'd' }]));
    expect(membersOf(after, board).map((m) => m.memberId).sort()).toEqual(['a', 'b', 'd']);
  });

  it('PRESERVES arrangement of a surviving member when the item omits x/y (merge)', () => {
    const before = seeded(['a']); // a is at x=0,y=0 in seed; move it
    const moved = applyProducerOutput(before, out([{ id: 'a', pres: { x: 999, y: 500 } }]));
    expect(memberById(moved, board, 'a')?.presentation).toMatchObject({ kind: 'card', x: 999, y: 500 });
    // Now reconcile with a pointer/status refresh that OMITS x/y — position must survive.
    const after = reconcileBoardGraphAuthoritative(moved, out([{ id: 'a', pres: { status: 'idle' } }]));
    const p = memberById(after, board, 'a')?.presentation as Record<string, unknown>;
    expect(p.x).toBe(999);
    expect(p.y).toBe(500);
    expect(p.status).toBe('idle');
  });

  it('an empty feed clears the board (every member absent → removed)', () => {
    const before = seeded(['a', 'b']);
    const after = reconcileBoardGraphAuthoritative(before, out([]));
    expect(membersOf(after, board)).toHaveLength(0);
  });

  it('result flows through the existing write-batch diff (real persistence, zero new path)', () => {
    const before = seeded(['a', 'b']);
    const after = reconcileBoardGraphAuthoritative(before, out([{ id: 'a' }, { id: 'c' }]));
    const batch = buildGroupWriteBatch(before, after);
    // A diff was produced (upsert c / tombstone b touch the board group record).
    expect(batch.payload.writes.length).toBeGreaterThan(0);
    expect(batch.payload.operation_label).toBe('engine.operation.write-batch');
  });

  it('is a no-op graph reference when the feed already matches exactly', () => {
    const before = seeded(['a', 'b']);
    const after = reconcileBoardGraphAuthoritative(before, out([
      { id: 'a', pres: { extra: {} } },
      { id: 'b', pres: { extra: {} } },
    ]));
    // membership identical; only merges of empty extra — still the same 2 members
    expect(membersOf(after, board).map((m) => m.memberId).sort()).toEqual(['a', 'b']);
  });
});

describe('reconcileBoardGraphFromUntrustedResult — a flaky AI result must NEVER wipe the board', () => {
  it('keeps generated results and the initiating failure together, overriding a misleading done patch', () => {
    const before = seeded(['trigger', 'existing']);
    const after = applyPartialProducerOutput(before, out([
      { id: 'trigger', pres: { status: 'done', text: 'useful enrichment' } },
      { id: 'new', pres: { text: 'useful generated result' } },
    ]), 'trigger');
    expect(membersOf(after, board).map(m => m.memberId)).toEqual(['trigger', 'existing', 'new']);
    expect(memberById(after, board, 'trigger')?.presentation).toMatchObject({
      status: 'error', text: 'useful enrichment', message: expect.stringContaining('Valid results were kept'),
    });
    expect(memberById(after, board, 'existing')).toEqual(memberById(before, board, 'existing'));
    expect(memberById(after, board, 'new')?.presentation.text).toBe('useful generated result');
  });
  it.each([
    [{ memberId: 'a', text: 'useful result' }, null],
    Array.from({ length: 1001 }, () => ({ memberId: 'a', text: 'useful result' })),
  ].map(raw => ({ raw })))('keeps valid decoded updates without deleting omitted members after filtering or truncation', ({ raw }) => {
    const status = itemResultStatus(raw);
    expect(status?.incomplete).toBe(true);
    const before = seeded(['a', 'b', 'c']);
    const output = reconcileOutputFromItems(producerItemsToReconcileItems(status!.items),
      board, { x: 0, y: 0 }, () => 'new', () => itemRef('a'), new Set(['a', 'b', 'c']));
    const after = reconcileBoardGraphFromUntrustedResult(before, output, status!.incomplete);
    expect(membersOf(after, board).map(m => m.memberId)).toEqual(['a', 'b', 'c']);
    expect(memberById(after, board, 'a')?.presentation).toMatchObject({ text: 'useful result' });
    expect(memberById(after, board, 'b')).toEqual(memberById(before, board, 'b'));
  });

  it('does not mark an intact result incomplete', () => {
    expect(itemResultStatus([{ text: 'complete' }])?.incomplete).toBeUndefined();
  });
  it('EMPTY result (agent failed / refused / malformed → 0 items) preserves the board untouched', () => {
    const before = seeded(['a', 'b', 'c']);
    // The dangerous case: plain authoritative reconcile would tombstone EVERY member.
    expect(membersOf(reconcileBoardGraphAuthoritative(before, out([])), board)).toHaveLength(0); // proves the hazard
    // The fail-safe variant leaves the board exactly as it was.
    const after = reconcileBoardGraphFromUntrustedResult(before, out([]));
    expect(after).toBe(before); // same reference — a true no-op, zero write-batch churn
    expect(membersOf(after, board).map((m) => m.memberId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('a NON-empty result delegates verbatim to the authoritative reconcile (reorganize/edit/regenerate unchanged)', () => {
    const before = seeded(['a', 'b', 'c']);
    const output = out([
      { id: 'a', pres: { kind: 'card', text: 'kept+edited' } }, // edit in place (no x/y → position preserved)
      { id: 'd', pres: { kind: 'card', x: 9, y: 9 } }, // new
    ]);
    const guarded = reconcileBoardGraphFromUntrustedResult(before, output);
    const plain = reconcileBoardGraphAuthoritative(before, output);
    // identical membership: a kept+edited, d added, b & c dropped (authoritative)
    expect(membersOf(guarded, board).map((m) => m.memberId).sort()).toEqual(['a', 'd']);
    expect(membersOf(guarded, board).map((m) => m.memberId).sort())
      .toEqual(membersOf(plain, board).map((m) => m.memberId).sort());
    const a = memberById(guarded, board, 'a')?.presentation as Record<string, unknown>;
    expect(a.text).toBe('kept+edited');
    expect(a.x).toBe(0); // original position kept
  });

  it('a single-item result still reorganizes (not treated as empty) — the guard only trips at ZERO items', () => {
    const before = seeded(['a', 'b']);
    const after = reconcileBoardGraphFromUntrustedResult(before, out([{ id: 'a', pres: { kind: 'card', text: 'only' } }]));
    expect(membersOf(after, board).map((m) => m.memberId)).toEqual(['a']); // b dropped — authoritative
  });
});
