// Proof for the metric GRAPH bridge: a metric co-locates on the item as extra.metric, set/bump flow
// through patchItem preserving other extra, clearing removes the field, bump is a no-op with no metric,
// connectors + furniture are never targets, metricRows rank by completion with labels.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import {
  boardMetricSummary,
  boardMetrics,
  bumpItemMetric,
  itemIsMetricTarget,
  metricOf,
  metricRows,
  setItemMetric,
} from './board-metric-actions';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

function board() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
  put({ memberId: 'books', kind: 'note', x: 0, y: 0, text: 'Read 12 books', extra: { fill: '#fff' } });
  put({ memberId: 'save', kind: 'note', x: 200, y: 0, text: 'Save 5000' });
  put({ memberId: 'edge', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'books', toMemberId: 'save' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, kind: 'note', x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-metric-actions — the graph bridge', () => {
  it('set stores the metric on the item as extra.metric, preserving other extra; clear removes it', () => {
    let g = board();
    g = setItemMetric(g, PARENT, 'books', { current: 5, target: 12, unit: 'books' });
    const item = readItems(g, PARENT).find((it) => it.memberId === 'books')!;
    expect(metricOf(g, PARENT, 'books')).toEqual({ current: 5, target: 12, unit: 'books' });
    expect(item.extra.fill).toBe('#fff'); // other extra untouched
    // clearing with null removes the field
    g = setItemMetric(g, PARENT, 'books', null);
    expect(metricOf(g, PARENT, 'books')).toBeNull();
    expect(readItems(g, PARENT).find((it) => it.memberId === 'books')!.extra.metric).toBeUndefined();
  });

  it('bump moves the current value; no metric yet is a no-op', () => {
    let g = board();
    // no metric → bump does nothing
    g = bumpItemMetric(g, PARENT, 'books', 3);
    expect(metricOf(g, PARENT, 'books')).toBeNull();
    // set then bump
    g = setItemMetric(g, PARENT, 'books', { current: 5, target: 12 });
    g = bumpItemMetric(g, PARENT, 'books', 3);
    expect(metricOf(g, PARENT, 'books')).toEqual({ current: 8, target: 12 });
    g = bumpItemMetric(g, PARENT, 'books', -1);
    expect(metricOf(g, PARENT, 'books')).toEqual({ current: 7, target: 12 });
  });

  it('boardMetrics + itemIsMetricTarget exclude connectors and furniture', () => {
    let g = board();
    g = setItemMetric(g, PARENT, 'books', { current: 5, target: 12 });
    const items = readItems(g, PARENT);
    const byId = (id: string) => items.find((it) => it.memberId === id)!;
    expect(itemIsMetricTarget(byId('books'))).toBe(true);
    expect(itemIsMetricTarget(byId('edge'))).toBe(false);
    expect(itemIsMetricTarget(byId(`${AXIS_TICK_PREFIX}x:10`))).toBe(false);
    expect(boardMetrics(items).map((m) => m.id)).toEqual(['books']); // only 'books' has a metric
  });

  it('metricRows rank by completion percent with item labels', () => {
    let g = board();
    g = setItemMetric(g, PARENT, 'books', { current: 3, target: 12 }); // 25%
    g = setItemMetric(g, PARENT, 'save', { current: 4500, target: 5000 }); // 90%
    const desc = metricRows(readItems(g, PARENT));
    expect(desc.map((r) => r.memberId)).toEqual(['save', 'books']); // most complete first
    expect(desc[0].label).toBe('Save 5000');
    expect(desc.map((r) => r.pct)).toEqual([90, 25]);
    const asc = metricRows(readItems(g, PARENT), false);
    expect(asc.map((r) => r.memberId)).toEqual(['books', 'save']); // least complete first
  });

  it('boardMetricSummary rolls up tracked / complete / mean percent (excludes metric-less cards)', () => {
    let g = board();
    expect(boardMetricSummary(readItems(g, PARENT))).toEqual({ tracked: 0, complete: 0, avgPct: 0 });
    g = setItemMetric(g, PARENT, 'books', { current: 12, target: 12 }); // 100% complete
    g = setItemMetric(g, PARENT, 'save', { current: 1000, target: 5000 }); // 20%
    // 'edge' (connector) + the axis tick are never counted even if they carried a metric.
    expect(boardMetricSummary(readItems(g, PARENT))).toEqual({ tracked: 2, complete: 1, avgPct: 60 });
  });
});
