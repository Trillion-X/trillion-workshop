// packages/group/read-data/board-readiness.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { classifyReadiness, readyIds, blockedReadiness, type CardReadiness } from '../../../read-data/board-readiness.ts';

// Injected-accessor fixtures — the engine is blind to the board (mirrors criticalPathOf's test style).
const completion = (map: Record<string, number | undefined>) => (id: string) => map[id];
const prereqs = (map: Record<string, string[]>) => (id: string) => map[id] ?? [];

describe('classifyReadiness', () => {
  it('a card with completion >= 1 is done (no blockers), regardless of its prerequisites', () => {
    const r = classifyReadiness(['a'], completion({ a: 1 }), prereqs({ a: ['b'] }));
    expect(r).toEqual<CardReadiness[]>([{ cardId: 'a', status: 'done', blockedBy: [] }]);
  });

  it('an unfinished card with NO prerequisite is ready (the actionable frontier)', () => {
    const r = classifyReadiness(['a'], completion({ a: 0 }), prereqs({}));
    expect(r[0]).toEqual({ cardId: 'a', status: 'ready', blockedBy: [] });
  });

  it('an unfinished card whose prerequisites are ALL done is ready', () => {
    const r = classifyReadiness(['a'], completion({ a: 0.5, b: 1, c: 1 }), prereqs({ a: ['b', 'c'] }));
    expect(r[0]).toEqual({ cardId: 'a', status: 'ready', blockedBy: [] });
  });

  it('a card with a measurably-incomplete prerequisite is blocked, listing only the unfinished ones (sorted, de-duped)', () => {
    const r = classifyReadiness(
      ['a'],
      completion({ a: 0, x: 0.4, y: 1, z: 0 }),
      prereqs({ a: ['z', 'x', 'y', 'x'] }), // y is done (cleared); x,z gate; x duplicated
    );
    expect(r[0]).toEqual({ cardId: 'a', status: 'blocked', blockedBy: ['x', 'z'] });
  });

  it('an UNTRACKED prerequisite (undefined completion) does NOT gate — same universe rule as boardCompletion', () => {
    // b has no metric/checklist -> undefined -> not measurably incomplete -> a is ready, not eternally blocked.
    const r = classifyReadiness(['a'], completion({ a: 0, b: undefined }), prereqs({ a: ['b'] }));
    expect(r[0]).toEqual({ cardId: 'a', status: 'ready', blockedBy: [] });
  });

  it('an untracked card with no blockers is ready (you cannot prove an untracked card done)', () => {
    const r = classifyReadiness(['a'], completion({ a: undefined }), prereqs({}));
    expect(r[0]).toEqual({ cardId: 'a', status: 'ready', blockedBy: [] });
  });

  it('over-achievement (completion already clamped upstream) treats >= 1 as done', () => {
    const r = classifyReadiness(['a'], completion({ a: 1 }), prereqs({}));
    expect(r[0].status).toBe('done');
  });
});

describe('readyIds / blockedReadiness selectors', () => {
  const rows: CardReadiness[] = [
    { cardId: 'r2', status: 'ready', blockedBy: [] },
    { cardId: 'd1', status: 'done', blockedBy: [] },
    { cardId: 'r1', status: 'ready', blockedBy: [] },
    { cardId: 'b1', status: 'blocked', blockedBy: ['x'] },
  ];
  it('readyIds returns only ready cards, sorted', () => {
    expect(readyIds(rows)).toEqual(['r1', 'r2']);
  });
  it('blockedReadiness returns only blocked rows with their blockers', () => {
    expect(blockedReadiness(rows)).toEqual([{ cardId: 'b1', status: 'blocked', blockedBy: ['x'] }]);
  });
});
