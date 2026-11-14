// Proof for the card-face progress readout: {percent, complete} from the cardCompletion SSOT, or null
// when the card tracks nothing (→ no strip → plain notes render byte-identically).
import { describe, expect, it } from 'vitest';
import { cardProgressView } from 'trillion-workshop/tools/organize-the-sidebar/read-data/card-progress-view.ts';
import type { BoardItem } from './group-board-model';

const item = (extra: Record<string, unknown>): BoardItem =>
  ({ memberId: 'm', kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, extra } as unknown as BoardItem);
const chk = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ id: `c${i}`, text: `t${i}`, done: i < done }));

describe('cardProgressView — the bottom-strip readout', () => {
  it('reports whole-percent completion + a complete flag from a metric', () => {
    expect(cardProgressView(item({ metric: { current: 5, target: 10 } }))).toEqual({ percent: 50, complete: false });
    expect(cardProgressView(item({ metric: { current: 10, target: 10 } }))).toEqual({ percent: 100, complete: true });
    expect(cardProgressView(item({ metric: { current: 15, target: 10 } }))).toEqual({ percent: 100, complete: true }); // over-target caps
  });

  it('falls back to the checklist fraction', () => {
    expect(cardProgressView(item({ checklist: chk(1, 4) }))).toEqual({ percent: 25, complete: false });
    expect(cardProgressView(item({ checklist: chk(3, 3) }))).toEqual({ percent: 100, complete: true });
  });

  it('returns null when the card tracks NOTHING (→ no strip, zero regression for plain notes)', () => {
    expect(cardProgressView(item({}))).toBeNull();
    expect(cardProgressView(item({ checklist: [] }))).toBeNull();
    expect(cardProgressView(item({ text: 'just a note' } as Record<string, unknown>))).toBeNull();
  });
});
