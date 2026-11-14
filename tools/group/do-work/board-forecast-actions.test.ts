// packages/group/do-work/board-forecast-actions.test.ts
import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef, GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { setItemMetric } from './board-metric-actions';
import { logMinutes } from './board-time-log-actions';
import { setItemDueDate } from './board-due-date-actions';
import {
  forecastOfItem,
  forecastRows,
  itemIsForecastTarget,
  boardForecastSummary,
} from './board-forecast-actions';

const REF: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function put(g: GroupGraph, id: string, text: string): GroupGraph {
  return placeItem(g, REF, { memberId: id, nodeRef: { family: 'p', parts: { id } }, kind: 'note', x: 0, y: 0, w: 100, h: 60, text } as never);
}
function connector(g: GroupGraph, id: string): GroupGraph {
  return placeItem(g, REF, { memberId: id, nodeRef: { family: 'p', parts: { id } }, kind: 'connector', x: 0, y: 0, w: 1, h: 1, extra: { fromMemberId: 'a', toMemberId: 'b' } } as never);
}
function items(g: GroupGraph) {
  return readItems(g, REF);
}

describe('board-forecast bridge composes metric + time-log + due', () => {
  it('projects a finish from remaining distance + logged pace', () => {
    let g = put(emptyGraph(), 'run', 'Run 5k');
    g = setItemMetric(g, REF, 'run', { current: 5, target: 10, start: 0 }); // remaining 5, progressed 5
    g = logMinutes(g, REF, 'run', 300, NOW); // 5h logged → velocity 1 unit/hr
    const f = forecastOfItem(items(g).find((i) => i.memberId === 'run')!, NOW);
    expect(f).not.toBeNull();
    expect(f!.verdict).toBe('moving'); // no due date yet
    expect(f!.hoursRemaining).toBe(5); // 5 units / 1 per hr
    expect(f!.projectedMs).toBe(NOW + 5 * HOUR);
  });

  it('with a due date the verdict is ahead/behind against it', () => {
    let g = put(emptyGraph(), 'run', 'Run 5k');
    g = setItemMetric(g, REF, 'run', { current: 5, target: 10, start: 0 });
    g = logMinutes(g, REF, 'run', 300, NOW); // velocity 1/hr → 5h to finish
    g = setItemDueDate(g, REF, 'run', NOW + 10 * HOUR); // deadline in 10h → ahead
    const ahead = forecastOfItem(items(g).find((i) => i.memberId === 'run')!, NOW)!;
    expect(ahead.verdict).toBe('ahead');
    expect(ahead.slackMs).toBe(5 * HOUR);

    g = setItemDueDate(g, REF, 'run', NOW + 2 * HOUR); // deadline in 2h, needs 5h → behind
    const behind = forecastOfItem(items(g).find((i) => i.memberId === 'run')!, NOW)!;
    expect(behind.verdict).toBe('behind');
    expect(behind.requiredVelocityPerHour).toBe(2.5); // 5 units / 2h
  });

  it('a goal with a metric but no logged time is stalled (no fake finish date)', () => {
    let g = put(emptyGraph(), 'diet', 'Eat clean');
    g = setItemMetric(g, REF, 'diet', { current: 2, target: 10, start: 0 });
    g = setItemDueDate(g, REF, 'diet', NOW + 4 * HOUR);
    const f = forecastOfItem(items(g).find((i) => i.memberId === 'diet')!, NOW)!;
    expect(f.verdict).toBe('stalled');
    expect(f.projectedMs).toBeNull();
    expect(f.requiredVelocityPerHour).toBe(2); // 8 units / 4h
  });

  it('a card with no metric is not a forecast target', () => {
    const g = put(emptyGraph(), 'idea', 'Someday: learn piano');
    const item = items(g).find((i) => i.memberId === 'idea')!;
    expect(itemIsForecastTarget(item)).toBe(false);
    expect(forecastOfItem(item, NOW)).toBeNull();
  });

  it('connectors are never forecast targets', () => {
    let g = put(emptyGraph(), 'a', 'A');
    g = connector(g, 'c1');
    expect(itemIsForecastTarget(items(g).find((i) => i.memberId === 'c1')!)).toBe(false);
  });

  it('forecastRows orders risk-first and the summary tallies at-risk vs on-pace', () => {
    let g = emptyGraph();
    // behind: far to go, slow pace, tight deadline
    g = put(g, 'behind', 'Behind goal');
    g = setItemMetric(g, REF, 'behind', { current: 1, target: 10, start: 0 });
    g = logMinutes(g, REF, 'behind', 600, NOW); // 9 units / 10h = 0.9/hr → 10h to finish, due in 1h
    g = setItemDueDate(g, REF, 'behind', NOW + HOUR);
    // ahead: almost done, quick pace, loose deadline
    g = put(g, 'ahead', 'Ahead goal');
    g = setItemMetric(g, REF, 'ahead', { current: 9, target: 10, start: 0 });
    g = logMinutes(g, REF, 'ahead', 60, NOW); // 9 units / 1h = 9/hr → ~0.1h, due in 5 days
    g = setItemDueDate(g, REF, 'ahead', NOW + 5 * DAY);
    // stalled: metric but no time
    g = put(g, 'stalled', 'Stalled goal');
    g = setItemMetric(g, REF, 'stalled', { current: 0, target: 10, start: 0 });

    const rows = forecastRows(items(g), NOW);
    expect(rows.map((r) => r.forecast.verdict)).toEqual(['behind', 'stalled', 'ahead']);
    const summary = boardForecastSummary(items(g), NOW);
    expect(summary.total).toBe(3);
    expect(summary.atRisk).toBe(2); // behind + stalled
    expect(summary.onPace).toBe(1); // ahead
  });
});
