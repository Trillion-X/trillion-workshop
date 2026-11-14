// Proof for the attention BRIDGE: each derived signal fires from real card DATA composed out of the
// other primitives' leaves (dueDate/metric/checklist/timeLog/habit), a healthy card scores 0, connectors
// + furniture are excluded, and attentionRows rank by score with the reason labels.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { setItemDueDate } from './board-due-date-actions';
import { setItemMetric } from './board-metric-actions';
import { toggleHabitToday } from './board-habit-actions';
import { addStepToItem } from './board-checklist-actions';
import { logMinutes } from './board-time-log-actions';
import { attentionOf, attentionRows, itemIsAttentionTarget } from './board-attention-actions';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const byId = (g: ReturnType<typeof emptyGraph>, id: string) => readItems(g, PARENT).find((it) => it.memberId === id)!;

function seed() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
  put({ memberId: 'overdue', x: 0, y: 0, text: 'Ship it' });
  put({ memberId: 'lapsed', x: 200, y: 0, text: 'Meditate' });
  put({ memberId: 'healthy', x: 400, y: 0, text: 'On track' });
  put({ memberId: 'edge', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'overdue', toMemberId: 'lapsed' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-attention-actions — derived-signal bridge', () => {
  it('a 74.5% near-due goal IS flagged low-progress (exact completion, not display-rounded to 75%)', () => {
    let g = seed();
    g = setItemDueDate(g, PARENT, 'overdue', NOW - DAY); // overdue
    g = setItemMetric(g, PARENT, 'overdue', { current: 74.5, target: 100, start: 0 }); // 74.5% — below 75
    // progressPct rounds 74.5 -> 75 and would suppress the signal; the exact completion 0.745 < 0.75 fires it.
    expect(attentionOf(byId(g, 'overdue'), NOW).reasons.map((r) => r.label)).toContain('Low progress, deadline near');
  });

  it('overdue + low-progress-near-due fire for an overdue, low, measured goal', () => {
    let g = seed();
    g = setItemDueDate(g, PARENT, 'overdue', NOW - 2 * DAY); // 2 days overdue
    g = setItemMetric(g, PARENT, 'overdue', { current: 2, target: 10 }); // 20% done < 75%
    const a = attentionOf(byId(g, 'overdue'), NOW);
    const keys = a.reasons.map((r) => r.label);
    expect(keys).toContain('Overdue');
    expect(keys).toContain('Low progress, deadline near');
    expect(a.score).toBeGreaterThan(0);
    // a mostly-done goal (90% >= 75%) near due does NOT flag low-progress (honest, not moralizing)
    let g2 = seed();
    g2 = setItemDueDate(g2, PARENT, 'overdue', NOW - 2 * DAY);
    g2 = setItemMetric(g2, PARENT, 'overdue', { current: 9, target: 10 });
    expect(attentionOf(byId(g2, 'overdue'), NOW).reasons.map((r) => r.label)).not.toContain('Low progress, deadline near');
  });

  it('stalled fires ONLY for a card that was tracked (has time history) then went quiet; not for untracked cards', () => {
    let g = seed();
    g = addStepToItem(g, PARENT, 'overdue', { id: 's1', text: 'do', done: false }); // open checklist, never timed
    // untracked open work must NOT flag stalled (Codex constraint — no moralizing every untracked card)
    expect(attentionOf(byId(g, 'overdue'), NOW).reasons.map((r) => r.label)).not.toContain('Stalled — no recent work');
    g = logMinutes(g, PARENT, 'overdue', 30, NOW - 30 * DAY); // was worked a month ago → tracked but stale
    expect(attentionOf(byId(g, 'overdue'), NOW).reasons.map((r) => r.label)).toContain('Stalled — no recent work');
    g = logMinutes(g, PARENT, 'overdue', 30, NOW); // worked today → no longer stalled
    expect(attentionOf(byId(g, 'overdue'), NOW).reasons.map((r) => r.label)).not.toContain('Stalled — no recent work');
  });

  it('streak-broken fires for a habit whose streak lapsed', () => {
    let g = seed();
    g = toggleHabitToday(g, PARENT, 'lapsed', NOW - 5 * DAY); // logged 5 days ago → current streak 0
    expect(attentionOf(byId(g, 'lapsed'), NOW).reasons.map((r) => r.label)).toContain('Habit lapsed');
  });

  it('a healthy card (no due, complete/absent work, recent effort) scores 0', () => {
    let g = seed();
    g = setItemMetric(g, PARENT, 'healthy', { current: 10, target: 10 }); // complete
    expect(attentionOf(byId(g, 'healthy'), NOW)).toEqual({ score: 0, reasons: [] });
  });

  it('connectors and furniture are never attention targets', () => {
    const g = seed();
    expect(itemIsAttentionTarget(byId(g, 'overdue'))).toBe(true);
    expect(itemIsAttentionTarget(byId(g, 'edge'))).toBe(false);
    expect(itemIsAttentionTarget(byId(g, `${AXIS_TICK_PREFIX}x:10`))).toBe(false);
  });

  it('attentionRows rank by score with reason labels, excluding calm cards + non-content', () => {
    let g = seed();
    g = setItemDueDate(g, PARENT, 'overdue', NOW - 2 * DAY);
    g = setItemMetric(g, PARENT, 'overdue', { current: 1, target: 10 });
    g = toggleHabitToday(g, PARENT, 'lapsed', NOW - 5 * DAY);
    const rows = attentionRows(readItems(g, PARENT), NOW);
    expect(rows[0].memberId).toBe('overdue'); // highest score
    expect(rows.map((r) => r.memberId)).toEqual(['overdue', 'lapsed']); // healthy + edge + tick excluded
    expect(rows[0].reasons).toContain('Overdue');
    expect(rows.find((r) => r.memberId === 'lapsed')!.reasons).toEqual(['Habit lapsed']);
  });
});
