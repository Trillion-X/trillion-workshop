// packages/group/do-work/board-card-merge.test.ts
import { describe, it, expect } from 'vitest';
import { planCardMerge, applyCardMerge } from './board-card-merge';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string, text: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 40, h: 30, isSection: false, childCount: 0, text, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string, relationKind?: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to, ...(relationKind ? { relationKind } : {}) } } as BoardItem);

describe('planCardMerge', () => {
  it('keeps the first card as primary and marks the rest for removal', () => {
    const items = [card('a', 'Book flight'), card('b', 'book the flight'), card('c', 'Other')];
    const plan = planCardMerge(items, ['a', 'b']);
    expect(plan.primaryId).toBe('a');
    expect(plan.removeMemberIds).toEqual(['b']);
  });

  it('joins the distinct non-empty texts, primary first, de-duping identical text', () => {
    const items = [card('a', 'Idea'), card('b', 'Idea'), card('c', 'Extra')];
    // a & b identical → one copy; c distinct
    expect(planCardMerge(items, ['a', 'b', 'c']).mergedText).toBe('Idea\n\nExtra');
  });

  it('honours an explicit primary', () => {
    const items = [card('a', 'A'), card('b', 'B')];
    const plan = planCardMerge(items, ['a', 'b'], 'b');
    expect(plan.primaryId).toBe('b');
    expect(plan.removeMemberIds).toEqual(['a']);
  });

  it('re-anchors a connector from a merged card onto the primary', () => {
    // x -> b, merging {a,b} into a: the connector should re-anchor to x -> a
    const items = [card('a', 'A'), card('b', 'B'), card('x', 'X'), link('c1', 'x', 'b')];
    const plan = planCardMerge(items, ['a', 'b']);
    expect(plan.reanchor).toEqual([{ memberId: 'c1', from: 'x', to: 'a' }]);
    expect(plan.removeMemberIds).toEqual(['b']); // c1 kept (re-anchored), only b removed
  });

  it('drops a connector that becomes a self-loop (both ends collapse onto primary)', () => {
    // a -> b, merging {a,b}: both ends become a → self-loop → drop the connector
    const items = [card('a', 'A'), card('b', 'B'), link('c1', 'a', 'b')];
    const plan = planCardMerge(items, ['a', 'b']);
    expect(plan.reanchor).toEqual([]);
    expect(plan.removeMemberIds).toEqual(['b', 'c1'].sort());
  });

  it('de-dupes connectors that collapse onto the same (from,to,kind)', () => {
    // x -> a and x -> b (same kind), merging {a,b} into a → both become x -> a → keep one, drop one
    const items = [card('a', 'A'), card('b', 'B'), card('x', 'X'), link('c1', 'x', 'a', 'blocks'), link('c2', 'x', 'b', 'blocks')];
    const plan = planCardMerge(items, ['a', 'b']);
    // c1 (x->a) already had the target pair — it does NOT move (a is primary), so only c2 re-anchors and
    // collides with c1's pair → c2 dropped. c1 untouched.
    expect(plan.reanchor).toEqual([]);
    expect(plan.removeMemberIds).toContain('c2');
    expect(plan.removeMemberIds).toContain('b');
  });

  it('keeps connectors of a DIFFERENT kind that collapse onto the same endpoints', () => {
    const items = [card('a', 'A'), card('b', 'B'), card('x', 'X'), link('c1', 'x', 'a', 'blocks'), link('c2', 'x', 'b', 'depends-on')];
    const plan = planCardMerge(items, ['a', 'b']);
    // c2 becomes x->a but a DIFFERENT kind than c1 → not a duplicate → re-anchored, kept
    expect(plan.reanchor).toEqual([{ memberId: 'c2', from: 'x', to: 'a' }]);
    expect(plan.removeMemberIds).toEqual(['b']);
  });

  it('is a no-op for fewer than 2 real cards', () => {
    const items = [card('a', 'A'), link('c1', 'a', 'a')];
    const plan = planCardMerge(items, ['a', 'c1']); // c1 is a connector, ignored → only 1 card
    expect(plan.removeMemberIds).toEqual([]);
    expect(plan.reanchor).toEqual([]);
  });

  it('is deterministic for a fixed board order (same input -> identical plan)', () => {
    const parts = [card('a', 'A'), card('b', 'B'), card('x', 'X'), link('c1', 'x', 'b'), link('c2', 'a', 'b')];
    expect(planCardMerge(parts, ['a', 'b'])).toEqual(planCardMerge(parts, ['a', 'b']));
  });

  it('picks the primary by BOARD (reading) order — the topmost merged card wins by default', () => {
    const parts = [card('a', 'A'), card('b', 'B')];
    expect(planCardMerge(parts, ['a', 'b']).primaryId).toBe('a'); // a is first in the board
    expect(planCardMerge([...parts].reverse(), ['a', 'b']).primaryId).toBe('b'); // now b is first
  });
});

describe('applyCardMerge', () => {
  it('produces the merged board: primary text updated, others gone, connectors re-anchored', () => {
    const items = [card('a', 'Book flight'), card('b', 'book the flight'), card('x', 'X'), link('c1', 'x', 'b')];
    const plan = planCardMerge(items, ['a', 'b']);
    const merged = applyCardMerge(items, plan);
    const ids = merged.map((i) => i.memberId).sort();
    expect(ids).toEqual(['a', 'c1', 'x']); // b gone
    expect(merged.find((i) => i.memberId === 'a')!.text).toBe('Book flight\n\nbook the flight');
    const c1 = merged.find((i) => i.memberId === 'c1')!;
    expect((c1.extra as Record<string, unknown>).toMemberId).toBe('a'); // re-anchored x -> a
    expect((c1.extra as Record<string, unknown>).fromMemberId).toBe('x');
  });

  it('does not mutate the input array', () => {
    const items = [card('a', 'A'), card('b', 'B'), link('c1', 'a', 'b')];
    const snapshot = JSON.stringify(items);
    applyCardMerge(items, planCardMerge(items, ['a', 'b']));
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});
