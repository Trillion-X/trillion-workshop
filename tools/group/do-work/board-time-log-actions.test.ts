// Proof for the time-log GRAPH bridge: sessions co-locate on the item as extra.timeLog, log/quick-add/
// remove-last/clear flow through patchItem preserving other extra, connectors + furniture are never
// targets, timeRows rank by effort (total + recent), and velocity composes metric + timeLog.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { setItemMetric } from './board-metric-actions';
import {
  boardTimeLogs,
  clearTimeLog,
  itemIsTimeTarget,
  itemVelocityPerHour,
  logMinutes,
  logSession,
  removeLastSession,
  timeLogOf,
  timeRows,
  totalTimeOf,
} from './board-time-log-actions';

const H = 3_600_000;
const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

function board() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
  put({ memberId: 'draft', kind: 'note', x: 0, y: 0, text: 'Write the draft', extra: { fill: '#fff' } });
  put({ memberId: 'research', kind: 'note', x: 200, y: 0, text: 'Research' });
  put({ memberId: 'edge', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'draft', toMemberId: 'research' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, kind: 'note', x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-time-log-actions — the graph bridge', () => {
  it('logSession stores sessions on the item as extra.timeLog, preserving other extra; clear removes it', () => {
    let g = board();
    g = logSession(g, PARENT, 'draft', { startMs: NOW - H, durationMs: H });
    const item = readItems(g, PARENT).find((it) => it.memberId === 'draft')!;
    expect(timeLogOf(g, PARENT, 'draft')).toEqual([{ startMs: NOW - H, durationMs: H }]);
    expect(item.extra.fill).toBe('#fff'); // other extra untouched
    expect(totalTimeOf(g, PARENT, 'draft')).toBe(H);
    // a non-positive duration is a no-op
    g = logSession(g, PARENT, 'draft', { startMs: NOW, durationMs: 0 });
    expect(timeLogOf(g, PARENT, 'draft').length).toBe(1);
    // clear removes the field entirely
    g = clearTimeLog(g, PARENT, 'draft');
    expect(readItems(g, PARENT).find((it) => it.memberId === 'draft')!.extra.timeLog).toBeUndefined();
  });

  it('logMinutes quick-adds and removeLastSession undoes the latest', () => {
    let g = board();
    g = logMinutes(g, PARENT, 'draft', 25, NOW - DAY);
    g = logMinutes(g, PARENT, 'draft', 50, NOW);
    expect(totalTimeOf(g, PARENT, 'draft')).toBe(75 * 60000);
    g = removeLastSession(g, PARENT, 'draft'); // drops the 50m (latest start)
    expect(timeLogOf(g, PARENT, 'draft').map((s) => s.durationMs)).toEqual([25 * 60000]);
  });

  it('boardTimeLogs + itemIsTimeTarget exclude connectors and furniture', () => {
    let g = board();
    g = logMinutes(g, PARENT, 'draft', 30, NOW);
    const items = readItems(g, PARENT);
    const byId = (id: string) => items.find((it) => it.memberId === id)!;
    expect(itemIsTimeTarget(byId('draft'))).toBe(true);
    expect(itemIsTimeTarget(byId('edge'))).toBe(false);
    expect(itemIsTimeTarget(byId(`${AXIS_TICK_PREFIX}x:10`))).toBe(false);
    expect(boardTimeLogs(items).map((t) => t.id)).toEqual(['draft']);
  });

  it('timeRows rank by total and by recent window with labels', () => {
    let g = board();
    g = logSession(g, PARENT, 'draft', { startMs: NOW - 10 * DAY, durationMs: 5 * H }); // old, big
    g = logSession(g, PARENT, 'research', { startMs: NOW - H, durationMs: 2 * H }); // recent, smaller
    const total = timeRows(readItems(g, PARENT), 'total');
    expect(total.map((r) => r.memberId)).toEqual(['draft', 'research']); // 5h > 2h
    expect(total[0].label).toBe('Write the draft');
    const recent = timeRows(readItems(g, PARENT), 'recent', NOW, 7 * DAY);
    expect(recent.map((r) => r.memberId)).toEqual(['research']); // only research inside the window
  });

  it('itemVelocityPerHour composes metric + timeLog (progress per hour), null without both', () => {
    let g = board();
    // no metric yet → null
    g = logMinutes(g, PARENT, 'draft', 120, NOW); // 2h
    expect(itemVelocityPerHour(g, PARENT, 'draft')).toBeNull();
    // metric: 6 units progressed over 2h → 3 units/hr
    g = setItemMetric(g, PARENT, 'draft', { current: 6, target: 12 });
    expect(itemVelocityPerHour(g, PARENT, 'draft')).toBeCloseTo(3);
    // descending goal reports positive velocity too (debt 5000 -> 0, now 3800 => moved 1200 in 2h = 600/hr)
    g = clearTimeLog(g, PARENT, 'research');
    g = logMinutes(g, PARENT, 'research', 120, NOW);
    g = setItemMetric(g, PARENT, 'research', { current: 3800, target: 0, start: 5000 });
    expect(itemVelocityPerHour(g, PARENT, 'research')).toBeCloseTo(600);
  });
});
