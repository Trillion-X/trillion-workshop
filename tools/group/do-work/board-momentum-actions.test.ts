// Proof for the momentum BRIDGE: each positive signal fires from real card DATA composed out of the
// other primitives' leaves, an idle card scores 0, connectors + furniture are excluded, momentumRows
// rank by score with reason labels — all through the SAME blind engine the attention lens uses.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { setItemMetric } from './board-metric-actions';
import { addStepToItem, toggleStepOnItem } from './board-checklist-actions';
import { logMinutes } from './board-time-log-actions';
import { toggleHabitToday } from './board-habit-actions';
import { periodStartOf, prevPeriodStart } from '../read-data/board-habit-cadence';
import { attentionRows } from './board-attention-actions';
import { itemIsMomentumTarget, momentumOf, momentumRows } from './board-momentum-actions';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const byId = (g: ReturnType<typeof emptyGraph>, id: string) => readItems(g, PARENT).find((it) => it.memberId === id)!;

function seed() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
  put({ memberId: 'rolling', x: 0, y: 0, text: 'Launch' });
  put({ memberId: 'habit', x: 200, y: 0, text: 'Meditate' });
  put({ memberId: 'idle', x: 400, y: 0, text: 'Someday' });
  put({ memberId: 'edge', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'rolling', toMemberId: 'habit' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-momentum-actions — derived positive-signal bridge', () => {
  it('a 74.5% goal does NOT fire metric-near-complete (exact completion, not display-rounded to 75%)', () => {
    let g = seed();
    g = setItemMetric(g, PARENT, 'rolling', { current: 74.5, target: 100, start: 0 }); // 74.5% — below 75
    // progressPct rounds 74.5 -> 75 and would falsely fire; the exact completion 0.745 < 0.75 does not.
    expect(momentumOf(byId(g, 'rolling'), NOW).reasons.map((r) => r.label)).not.toContain('Metric nearly complete');
  });

  it('recent-effort + metric-near-complete fire for a card worked recently and almost done', () => {
    let g = seed();
    g = logMinutes(g, PARENT, 'rolling', 90, NOW); // 90m this week
    g = setItemMetric(g, PARENT, 'rolling', { current: 8, target: 10 }); // 80% >= 75%
    const reasons = momentumOf(byId(g, 'rolling'), NOW).reasons.map((r) => r.label);
    expect(reasons).toContain('Recent effort');
    expect(reasons).toContain('Metric nearly complete');
    // a metric under 75% does NOT fire metric-near-complete
    let g2 = seed();
    g2 = setItemMetric(g2, PARENT, 'rolling', { current: 3, target: 10 });
    expect(momentumOf(byId(g2, 'rolling'), NOW).reasons.map((r) => r.label)).not.toContain('Metric nearly complete');
  });

  it('active-streak fires for a live habit, and checklist-near-complete for a mostly-checked list', () => {
    let g = seed();
    g = toggleHabitToday(g, PARENT, 'habit', NOW); // streak 1 today
    expect(momentumOf(byId(g, 'habit'), NOW).reasons.map((r) => r.label)).toContain('Active streak');
    // checklist 3/4 done (>= 0.75, total >= 2, not complete)
    let g2 = seed();
    for (const s of ['a', 'b', 'c', 'd']) g2 = addStepToItem(g2, PARENT, 'rolling', { id: s, text: s, done: false });
    for (const s of ['a', 'b', 'c']) g2 = toggleStepOnItem(g2, PARENT, 'rolling', s);
    expect(momentumOf(byId(g2, 'rolling'), NOW).reasons.map((r) => r.label)).toContain('Checklist nearly complete');
  });

  it('an idle card (no recent effort, no streak, low/complete metric) scores 0', () => {
    let g = seed();
    g = logMinutes(g, PARENT, 'idle', 60, NOW - 60 * DAY); // effort long ago, outside window
    g = setItemMetric(g, PARENT, 'idle', { current: 10, target: 10 }); // complete → not "nearly"
    expect(momentumOf(byId(g, 'idle'), NOW)).toEqual({ score: 0, reasons: [] });
  });

  it('connectors and furniture are never momentum targets', () => {
    const g = seed();
    expect(itemIsMomentumTarget(byId(g, 'rolling'))).toBe(true);
    expect(itemIsMomentumTarget(byId(g, 'edge'))).toBe(false);
    expect(itemIsMomentumTarget(byId(g, `${AXIS_TICK_PREFIX}x:10`))).toBe(false);
  });

  it('momentumRows rank by score with reason labels, excluding idle cards + non-content', () => {
    let g = seed();
    g = logMinutes(g, PARENT, 'rolling', 120, NOW); // full recent-effort (1.5) + ...
    g = setItemMetric(g, PARENT, 'rolling', { current: 9, target: 10 }); // metric-near (1*0.9)
    g = toggleHabitToday(g, PARENT, 'habit', NOW); // active-streak (1.25 * 1/7)
    const rows = momentumRows(readItems(g, PARENT), NOW);
    expect(rows[0].memberId).toBe('rolling'); // highest score
    expect(rows.map((r) => r.memberId)).toEqual(['rolling', 'habit']); // idle + edge + tick excluded
    expect(rows[0].reasons).toContain('Recent effort');
    expect(rows.find((r) => r.memberId === 'habit')!.reasons).toEqual(['Active streak']);
  });

  it('CADENCE FIX: a met 3x/week habit shows momentum (Active streak) and is NOT flagged "Habit lapsed"', () => {
    const WK = periodStartOf(NOW, 'week');
    const WK_1 = prevPeriodStart(WK, 'week');
    // A 3x/week cadence habit that met this week (gapped) + last week — on cadence, non-consecutive days.
    let g = placeItem(emptyGraph(), PARENT, { nodeRef: { family: 't', parts: { id: 'habit' } }, w: 100, h: 60, kind: 'note', memberId: 'habit', x: 0, y: 0, text: 'Gym', extra: { habitCadence: { period: 'week', times: 3 }, habitLog: [WK, WK + 2 * DAY, WK + 4 * DAY, WK_1, WK_1 + DAY, WK_1 + 2 * DAY] } } as never);
    // MOMENTUM: the cadence streak (2 weeks) fires Active streak — before the fix this scored ~0 (no daily streak).
    expect(momentumOf(byId(g, 'habit'), NOW).reasons.map((r) => r.label)).toContain('Active streak');
    // ATTENTION: it is NOT lapsed despite non-consecutive days (the moralizing bug is gone).
    const lapsed = attentionRows(readItems(g, PARENT), NOW).find((r) => r.memberId === 'habit');
    expect(lapsed?.reasons ?? []).not.toContain('Habit lapsed');
  });
});
