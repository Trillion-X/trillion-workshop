// Proof for the unified card-completion reading (read-data leaf): metric-first, else checklist, else
// undefined; metric completion CLAMPED to [0,1]. The SSOT the "Sort by progress" arrange and the goal
// rollup both consume — one reading so they can never disagree.
import { describe, expect, it } from 'vitest';
import { cardCompletion } from 'trillion-workshop/tools/organize-the-sidebar/read-data/card-completion.ts';
import type { BoardItem } from './group-board-model';

const item = (extra: Record<string, unknown>): BoardItem =>
  ({ memberId: 'm', kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, extra } as unknown as BoardItem);
const chk = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ id: `c${i}`, text: `t${i}`, done: i < done }));

describe('cardCompletion — unified metric/checklist completion', () => {
  it('reads a metric first (current toward target), clamped to [0,1]', () => {
    expect(cardCompletion(item({ metric: { current: 5, target: 10 } }))).toBeCloseTo(0.5);
    expect(cardCompletion(item({ metric: { current: 0, target: 10 } }))).toBe(0);
    expect(cardCompletion(item({ metric: { current: 15, target: 10 } }))).toBe(1); // over-target caps at 1 (never 1.5)
  });

  it('falls back to the checklist fraction when there is no metric', () => {
    expect(cardCompletion(item({ checklist: chk(3, 4) }))).toBeCloseTo(0.75);
    expect(cardCompletion(item({ checklist: chk(0, 2) }))).toBe(0);
    expect(cardCompletion(item({ checklist: chk(2, 2) }))).toBe(1);
  });

  it('metric WINS when a card has both (an explicit target beats a task tally)', () => {
    expect(cardCompletion(item({ metric: { current: 8, target: 10 }, checklist: chk(0, 4) }))).toBeCloseTo(0.8);
  });

  it('returns undefined when there is neither a metric nor a checklist (unmeasurable)', () => {
    expect(cardCompletion(item({}))).toBeUndefined();
    expect(cardCompletion(item({ checklist: [] }))).toBeUndefined(); // empty checklist → nothing to measure
    expect(cardCompletion(item({ metric: { current: 5 } }))).toBeUndefined(); // malformed metric (no target) → not a metric
  });
});
