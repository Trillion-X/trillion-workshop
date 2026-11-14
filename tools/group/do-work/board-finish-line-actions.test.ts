// Proof for the finish-line BRIDGE: the THIRD DATA registry over the ONE weighted-signal engine. Each
// proximity signal fires from real metric/checklist DATA, a fully-done or far-from-done card scores 0,
// connectors + furniture are excluded, and finishLineRows rank CLOSEST-to-done first. The keystone test is
// the CROSS-LENS RANK INVERSION: two cards rank in OPPOSITE order under momentum vs finish-line — proving
// the lens is genuinely distinct (proximity-pure), not a slice of momentum.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { setItemMetric } from './board-metric-actions';
import { addStepToItem, toggleStepOnItem } from './board-checklist-actions';
import { logMinutes } from './board-time-log-actions';
import { momentumRows } from './board-momentum-actions';
import { itemIsFinishLineTarget, finishLineOf, finishLineRows } from './board-finish-line-actions';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const byId = (g: ReturnType<typeof emptyGraph>, id: string) => readItems(g, PARENT).find((it) => it.memberId === id)!;

function seed() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
  put({ memberId: 'nearly', x: 0, y: 0, text: 'Ship v1' });
  put({ memberId: 'started', x: 200, y: 0, text: 'Draft plan' });
  put({ memberId: 'idle', x: 400, y: 0, text: 'Someday' });
  put({ memberId: 'edge', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'nearly', toMemberId: 'started' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-finish-line-actions — proximity-to-done lens', () => {
  it('a 74.5% goal does NOT fire (exact completion 0.745 < 0.75, not display-rounded to 75)', () => {
    let g = seed();
    g = setItemMetric(g, PARENT, 'nearly', { current: 74.5, target: 100, start: 0 });
    expect(finishLineOf(byId(g, 'nearly'), NOW).reasons.map((r) => r.label)).not.toContain('Metric almost done');
  });

  it('metric-almost-done fires at/above 75% and NOT when complete (a done track is not a candidate)', () => {
    let g = seed();
    g = setItemMetric(g, PARENT, 'nearly', { current: 8, target: 10 }); // 80% >= 75
    expect(finishLineOf(byId(g, 'nearly'), NOW).reasons.map((r) => r.label)).toContain('Metric almost done');
    let done = seed();
    done = setItemMetric(done, PARENT, 'nearly', { current: 10, target: 10 }); // complete → excluded
    expect(finishLineOf(byId(done, 'nearly'), NOW)).toEqual({ score: 0, reasons: [] });
  });

  it('checklist-almost-done fires for a mostly-checked list (>= 0.75, total >= 2, not complete)', () => {
    let g = seed();
    for (const s of ['a', 'b', 'c', 'd']) g = addStepToItem(g, PARENT, 'started', { id: s, text: s, done: false });
    for (const s of ['a', 'b', 'c']) g = toggleStepOnItem(g, PARENT, 'started', s); // 3/4
    expect(finishLineOf(byId(g, 'started'), NOW).reasons.map((r) => r.label)).toContain('Checklist almost done');
  });

  it('the score is the completion FRACTION, so rows rank CLOSEST-to-done first', () => {
    let g = seed();
    g = setItemMetric(g, PARENT, 'nearly', { current: 98, target: 100 }); // 0.98
    g = setItemMetric(g, PARENT, 'started', { current: 76, target: 100 }); // 0.76
    const rows = finishLineRows(readItems(g, PARENT), NOW);
    expect(rows.map((r) => r.memberId)).toEqual(['nearly', 'started']); // idle + edge + tick excluded
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(rows[0].reasons).toEqual(['Metric almost done']);
  });

  it('KEYSTONE — cross-lens inversion: the card momentum ranks FIRST, finish-line ranks LAST', () => {
    // `started` is only 76% done but was worked on TODAY; `nearly` is 98% done but untouched for weeks.
    // Momentum rewards recent effort → ranks `started` first. Finish-line is proximity-pure → ranks
    // `nearly` first. Same two cards, OPPOSITE order → the lens is genuinely distinct, not a momentum slice.
    let g = seed();
    g = setItemMetric(g, PARENT, 'nearly', { current: 98, target: 100 }); // 0.98, no recent effort
    g = setItemMetric(g, PARENT, 'started', { current: 76, target: 100 }); // 0.76 ...
    g = logMinutes(g, PARENT, 'started', 120, NOW); // ...worked 2h today (full momentum recent-effort)

    const momentum = momentumRows(readItems(g, PARENT), NOW).map((r) => r.memberId);
    const finish = finishLineRows(readItems(g, PARENT), NOW).map((r) => r.memberId);
    expect(momentum[0]).toBe('started'); // momentum: effort wins
    expect(finish[0]).toBe('nearly'); //  finish-line: proximity wins
    expect(finish).toEqual([...momentum].reverse()); // literally the opposite order
  });

  it('a far-from-done card and a fully-done card both score 0 (only the "almost" band lists)', () => {
    let far = seed();
    far = setItemMetric(far, PARENT, 'nearly', { current: 3, target: 10 }); // 30% — not almost
    expect(finishLineOf(byId(far, 'nearly'), NOW)).toEqual({ score: 0, reasons: [] });
    let g = seed();
    g = logMinutes(g, PARENT, 'idle', 60, NOW - 60 * DAY); // effort is irrelevant to this lens
    expect(finishLineOf(byId(g, 'idle'), NOW)).toEqual({ score: 0, reasons: [] });
  });

  it('connectors and furniture are never finish-line targets', () => {
    const g = seed();
    expect(itemIsFinishLineTarget(byId(g, 'nearly'))).toBe(true);
    expect(itemIsFinishLineTarget(byId(g, 'edge'))).toBe(false);
    expect(itemIsFinishLineTarget(byId(g, `${AXIS_TICK_PREFIX}x:10`))).toBe(false);
  });
});
