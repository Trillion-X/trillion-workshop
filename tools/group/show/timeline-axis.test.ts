// packages/group/show/timeline-axis.test.ts
import { describe, it, expect } from 'vitest';
import {
  TIMELINE_DATE_FIELDS,
  timelineFieldById,
  timelineAxisItems,
  timelineDomain,
  timelineTickMarks,
} from './timeline-axis';
import { axisPlot } from './arrange-by-axis';
import type { BoardItem } from '../read-data/group-board-model';

const note = (memberId: string, extra: Record<string, unknown> = {}): BoardItem =>
  ({ memberId, nodeRef: { id: memberId } as never, kind: 'note', x: 0, y: 0, w: 80, h: 50, isSection: false, childCount: 0, extra } as BoardItem);

const due = timelineFieldById('due').dateOf;

describe('TIMELINE_DATE_FIELDS catalog', () => {
  it('ships due/created/scheduled + resolves by id (fallback to first)', () => {
    expect(TIMELINE_DATE_FIELDS.map((f) => f.id)).toEqual(['due', 'created', 'scheduled']);
    expect(timelineFieldById('created').id).toBe('created');
    expect(timelineFieldById('nope').id).toBe('due');
  });
});

describe('timelineAxisItems + timelineDomain', () => {
  it('maps items to parsed-date valueX; undated items get valueX null (park)', () => {
    const items = [note('a', { dueDate: '2026-03-01' }), note('b', { dueDate: 'garbage' }), note('c', {})];
    const axis = timelineAxisItems(items, due);
    expect(axis[0].valueX).toBe(Date.UTC(2026, 2, 1));
    expect(axis[1].valueX).toBeNull();
    expect(axis[2].valueX).toBeNull();
  });
  it('excludes connectors', () => {
    const items = [note('a', { dueDate: '2026-01-01' }), note('e', { dueDate: '2026-01-01', fromMemberId: 'a', toMemberId: 'a' })];
    expect(timelineAxisItems(items, due)).toHaveLength(1);
  });
  it('domain is the min/max parsed date; null when none dated', () => {
    const items = [note('a', { dueDate: '2026-02-01' }), note('b', { dueDate: '2026-05-01' })];
    expect(timelineDomain(items, due)).toEqual({ min: Date.UTC(2026, 1, 1), max: Date.UTC(2026, 4, 1) });
    expect(timelineDomain([note('x', {})], due)).toBeNull();
  });
});

describe('timeline placement via axisPlot (chronological order)', () => {
  it('earlier dates land LEFT of later dates on the 1-D axis', () => {
    const items = [
      note('mar', { dueDate: '2026-03-15' }),
      note('jan', { dueDate: '2026-01-05' }),
      note('jun', { dueDate: '2026-06-20' }),
    ];
    const placed = axisPlot(timelineAxisItems(items, due), { originX: 0, spanX: 600, laneY: 0 }).placed;
    const byId = new Map(placed.map((p) => [p.memberId, p.x]));
    expect(byId.get('jan')!).toBeLessThan(byId.get('mar')!);
    expect(byId.get('mar')!).toBeLessThan(byId.get('jun')!);
  });

  it('undated items park off-axis (onAxis false)', () => {
    const items = [note('a', { dueDate: '2026-01-01' }), note('none', {})];
    const placed = axisPlot(timelineAxisItems(items, due), { spanX: 400 }).placed;
    expect(placed.find((p) => p.memberId === 'none')!.onAxis).toBe(false);
    expect(placed.find((p) => p.memberId === 'a')!.onAxis).toBe(true);
  });
});

describe('timelineTickMarks', () => {
  it('produces dated, ascending, positioned marks aligned to the axis', () => {
    const items = [note('a', { dueDate: '2026-01-10' }), note('b', { dueDate: '2026-06-10' })];
    const marks = timelineTickMarks(items, { dateOf: due, originX: 0, spanX: 600 });
    expect(marks.length).toBeGreaterThan(1);
    expect(marks.every((m) => /\d{4}|[A-Z][a-z]{2}/.test(m.label))).toBe(true); // real date labels
    for (let i = 1; i < marks.length; i++) expect(marks[i].pos).toBeGreaterThanOrEqual(marks[i - 1].pos);
    expect(marks.every((m) => Number.isFinite(m.pos))).toBe(true);
  });
  it('no dated items → no marks', () => {
    expect(timelineTickMarks([note('x', {})], { dateOf: due })).toEqual([]);
  });
});
