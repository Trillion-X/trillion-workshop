// packages/group/do-work/board-card-split.test.ts
import { describe, it, expect } from 'vitest';
import { splitSegments, planCardSplit, applyCardSplit } from './board-card-split';
import type { BoardItem } from '../read-data/group-board-model';

const card = (memberId: string, text: string, x = 10, y = 20, w = 100, h = 40): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x, y, w, h, isSection: false, childCount: 0, text, extra: {} } as BoardItem);
const link = (memberId: string, from: string, to: string): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 4, h: 4, isSection: false, childCount: 0, extra: { fromMemberId: from, toMemberId: to } } as BoardItem);

const mintSeq = () => {
  let n = 0;
  return () => 'k' + n++;
};

describe('splitSegments', () => {
  it('splits on newlines and trims', () => {
    expect(splitSegments('one\ntwo\nthree')).toEqual(['one', 'two', 'three']);
  });
  it('strips leading dash / star / bullet markers', () => {
    expect(splitSegments('- flight\n* hotel\n• car')).toEqual(['flight', 'hotel', 'car']);
  });
  it('strips ordinal markers (1. / 1))', () => {
    expect(splitSegments('1. first\n2) second')).toEqual(['first', 'second']);
  });
  it('drops blank lines', () => {
    expect(splitSegments('a\n\n   \nb')).toEqual(['a', 'b']);
  });
  it('a single line of prose is ONE segment (will not split)', () => {
    expect(splitSegments('just one idea')).toEqual(['just one idea']);
  });
});

describe('planCardSplit', () => {
  it('produces one child per segment, stacked below the original', () => {
    const plan = planCardSplit(card('a', 'flight\nhotel\ncar', 10, 20, 100, 40), mintSeq());
    expect(plan.childCards.map((c) => c.text)).toEqual(['flight', 'hotel', 'car']);
    // stacked: y = 20, 20+56, 20+112 (h 40 + gap 16 = 56)
    expect(plan.childCards.map((c) => c.y)).toEqual([20, 76, 132]);
    expect(plan.childCards.every((c) => c.x === 10 && c.w === 100 && c.h === 40)).toBe(true);
    expect(plan.headId).toBe(plan.childCards[0].memberId);
    expect(plan.removeMemberId).toBe('a');
  });

  it('is a no-op for a single-segment card', () => {
    const plan = planCardSplit(card('a', 'one idea'), mintSeq());
    expect(plan.childCards).toEqual([]);
    expect(plan.removeMemberId).toBe('a');
  });

  it('mints fresh ids from the injected mint (deterministic)', () => {
    const plan = planCardSplit(card('a', 'x\ny'), mintSeq());
    expect(plan.childCards.map((c) => c.memberId)).toEqual(['k0', 'k1']);
  });
});

describe('applyCardSplit', () => {
  it('replaces the original with its children and re-anchors its connectors onto the head', () => {
    // h -> a (a is the multi-line card being split); after split, the connector points at the head child.
    const items = [card('a', 'flight\nhotel'), card('h', 'Trip', 200, 20), link('c1', 'h', 'a')];
    const plan = planCardSplit(items[0], mintSeq());
    const out = applyCardSplit(items, plan);
    // a is gone; two children + h + c1 remain
    expect(out.find((i) => i.memberId === 'a')).toBeUndefined();
    const children = out.filter((i) => i.memberId === 'k0' || i.memberId === 'k1');
    expect(children.map((c) => c.text)).toEqual(['flight', 'hotel']);
    // c1 re-anchored h -> k0 (the head)
    const c1 = out.find((i) => i.memberId === 'c1')!;
    expect((c1.extra as Record<string, unknown>).toMemberId).toBe('k0');
    expect((c1.extra as Record<string, unknown>).fromMemberId).toBe('h');
  });

  it('is a no-op array copy for a single-segment card', () => {
    const items = [card('a', 'one')];
    expect(applyCardSplit(items, planCardSplit(items[0], mintSeq())).map((i) => i.memberId)).toEqual(['a']);
  });

  it('does not mutate the input', () => {
    const items = [card('a', 'x\ny'), card('h', 'H'), link('c1', 'h', 'a')];
    const snapshot = JSON.stringify(items);
    applyCardSplit(items, planCardSplit(items[0], mintSeq()));
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});
