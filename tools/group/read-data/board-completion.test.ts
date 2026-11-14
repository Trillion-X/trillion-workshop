// Proof for the whole-board card-equal completion summary: counts CARDS (metric OR checklist), each one
// vote, over the cardCompletion SSOT; plain notes are excluded; avg is over EXACT completions.
import { describe, expect, it } from 'vitest';
import { boardCompletion } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-completion.ts';
import type { BoardItem } from './group-board-model';

const item = (extra: Record<string, unknown>): BoardItem =>
  ({ memberId: 'm', kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, extra } as unknown as BoardItem);
const chk = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ id: `c${i}`, text: `t${i}`, done: i < done }));

describe('boardCompletion — card-equal whole-board summary', () => {
  it('counts each tracked card once and averages their EXACT completions (metric + checklist mixed)', () => {
    const items = [
      item({ metric: { current: 10, target: 10 } }), // 100% (complete)
      item({ checklist: chk(1, 4) }), // 25%
      item({ checklist: chk(3, 4) }), // 75%
      item({ metric: { current: 5, target: 10 } }), // 50%
      item({}), // plain note → excluded
      item({ text: 'note' } as Record<string, unknown>), // plain → excluded
    ];
    const r = boardCompletion(items);
    expect(r.tracked).toBe(4); // 4 cards track completion; 2 plain notes excluded
    expect(r.complete).toBe(1); // only the 100% metric card
    expect(r.avgPct).toBe(63); // mean(1, .25, .75, .5) = 0.625 → 63%
  });

  it('a metric card counts once even if it also has a checklist (cardCompletion is metric-first)', () => {
    const items = [item({ metric: { current: 8, target: 10 }, checklist: chk(0, 4) })];
    expect(boardCompletion(items)).toEqual({ tracked: 1, complete: 0, avgPct: 80 }); // 80% metric, not 0% checklist
  });

  it('an all-plain / empty board tracks nothing (the readout hides at tracked===0)', () => {
    expect(boardCompletion([item({}), item({})])).toEqual({ tracked: 0, complete: 0, avgPct: 0 });
    expect(boardCompletion([])).toEqual({ tracked: 0, complete: 0, avgPct: 0 });
  });

  it('all tracked cards complete → 100% average, complete === tracked', () => {
    const items = [item({ metric: { current: 10, target: 10 } }), item({ checklist: chk(3, 3) })];
    expect(boardCompletion(items)).toEqual({ tracked: 2, complete: 2, avgPct: 100 });
  });
});
