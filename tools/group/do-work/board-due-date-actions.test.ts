// Proof for the due-date GRAPH bridge: due dates co-locate on the item as extra.dueDate, set/clear via
// patchItem preserving other extra, connectors + furniture never targets, dueRows sorted with labels.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX, arrangeSelectionOnAxis, itemIsAxisTick } from './batch-actions';
import { dueMsToDateLabel } from '../read-data/board-due-date';
import { checklistFromRaw, checklistProgress } from '../read-data/board-checklist';
import {
  boardDueItems,
  dueDateOf,
  dueDateOfItem,
  dueRows,
  itemIsDueTarget,
  overdueCount,
  setItemDueDate,
} from './board-due-date-actions';

const DAY = 86_400_000;
const NOW = Math.floor(1_760_000_000_000 / DAY) * DAY + 12 * 3_600_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

function board() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
  put({ memberId: 'goal', kind: 'note', x: 0, y: 0, text: 'Launch', extra: { fill: '#fff' } });
  put({ memberId: 'later', kind: 'note', x: 200, y: 0, text: 'Someday' });
  put({ memberId: 'edge', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'goal', toMemberId: 'later' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, kind: 'note', x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-due-date-actions — the graph bridge', () => {
  it('setItemDueDate stores it on the item as extra.dueDate, preserving other extra; null clears', () => {
    let g = board();
    g = setItemDueDate(g, PARENT, 'goal', NOW + 5 * DAY);
    const goal = readItems(g, PARENT).find((it) => it.memberId === 'goal')!;
    expect(dueDateOf(g, PARENT, 'goal')).toBe(NOW + 5 * DAY);
    expect(goal.extra.fill).toBe('#fff'); // other extra untouched
    g = setItemDueDate(g, PARENT, 'goal', null);
    expect(dueDateOf(g, PARENT, 'goal')).toBeNull();
  });

  it('boardDueItems + itemIsDueTarget exclude connectors and furniture', () => {
    let g = board();
    g = setItemDueDate(g, PARENT, 'goal', NOW + DAY);
    const items = readItems(g, PARENT);
    const byId = (id: string) => items.find((it) => it.memberId === id)!;
    expect(itemIsDueTarget(byId('goal'))).toBe(true);
    expect(itemIsDueTarget(byId('edge'))).toBe(false);
    expect(itemIsDueTarget(byId(`${AXIS_TICK_PREFIX}x:10`))).toBe(false);
    expect(boardDueItems(items).map((d) => d.id)).toEqual(['goal']); // only 'goal' has a due date
  });

  it('dueRows: nearest due first with item labels + relative readout; overdueCount counts past', () => {
    let g = board();
    g = setItemDueDate(g, PARENT, 'goal', NOW - 2 * DAY); // overdue
    g = setItemDueDate(g, PARENT, 'later', NOW + 6 * DAY); // upcoming
    const rows = dueRows(readItems(g, PARENT), NOW);
    expect(rows.map((r) => r.memberId)).toEqual(['goal', 'later']); // overdue first
    expect(rows[0].label).toBe('Launch');
    expect(rows[0].relative).toMatchObject({ overdue: true, urgency: 'overdue' });
    expect(rows[1].relative).toMatchObject({ overdue: false, urgency: 'upcoming' });
    expect(overdueCount(readItems(g, PARENT), NOW)).toBe(1);
  });

  it('DUE-DATE TIMELINE (cont.98 batch-58): arrangeSelectionOnAxis + dueDateOfItem plots by date, undated parks below, ticks are dates', () => {
    // Four notes: three DATED (scrambled initial x) + one UNDATED. The timeline row injects
    // dueDateOfItem as the numeric axis value → the SAME arrange-by-axis engine, zero new geometry.
    let g = emptyGraph();
    const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
    put({ memberId: 'mid', x: 500, y: 0, text: 'Mid' });
    put({ memberId: 'early', x: 100, y: 0, text: 'Early' });
    put({ memberId: 'late', x: 900, y: 0, text: 'Late' });
    put({ memberId: 'someday', x: 300, y: 0, text: 'Someday' }); // no due date → parks below
    g = setItemDueDate(g, PARENT, 'early', NOW + 2 * DAY);
    g = setItemDueDate(g, PARENT, 'mid', NOW + 10 * DAY);
    g = setItemDueDate(g, PARENT, 'late', NOW + 40 * DAY);

    const ids = ['mid', 'early', 'late', 'someday'];
    g = arrangeSelectionOnAxis(g, PARENT, ids, (i) => ({ x: dueDateOfItem(i) }), { showAxis: true, format: dueMsToDateLabel });

    const items = readItems(g, PARENT);
    const x = (id: string) => items.find((it) => it.memberId === id)!.x;
    const y = (id: string) => items.find((it) => it.memberId === id)!.y;
    // dated cards ordered left→right by due date (earliest = leftmost), independent of initial x:
    expect(x('early')).toBeLessThan(x('mid'));
    expect(x('mid')).toBeLessThan(x('late'));
    // the undated card parked BELOW every dated card (no-value pile), not dropped:
    const datedMaxY = Math.max(y('early'), y('mid'), y('late'));
    expect(y('someday')).toBeGreaterThan(datedMaxY);
    // the axis materialized real YYYY-MM-DD date ticks (via dueMsToDateLabel), not raw ms:
    const tickLabels = items.filter(itemIsAxisTick).map((t) => t.text ?? '');
    expect(tickLabels.length).toBeGreaterThanOrEqual(2);
    expect(tickLabels.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t))).toBe(true);
  });

  it('HETEROGENEOUS SCATTER (cont.98 batch-59): due date (X, dates) vs progress (Y, %) label each axis with its OWN formatter', () => {
    // The per-axis-formatter completion: X = due date, Y = checklist progress. A single shared
    // formatter would mislabel Y (0.5 → a bogus date); formatX/formatY fix that structurally.
    const cl = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ id: `c${i}`, text: `t${i}`, done: i < done }));
    let g = emptyGraph();
    const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
    put({ memberId: 'a', x: 0, y: 0, text: 'A', extra: { checklist: cl(1, 4) } }); // 25%
    put({ memberId: 'b', x: 0, y: 0, text: 'B', extra: { checklist: cl(3, 4) } }); // 75%
    put({ memberId: 'c', x: 0, y: 0, text: 'C', extra: { checklist: cl(0, 2) } }); // 0% (has a checklist → plots at bottom)
    put({ memberId: 'nolist', x: 0, y: 0, text: 'No list' }); // no checklist → parks (y null)
    g = setItemDueDate(g, PARENT, 'a', NOW + 2 * DAY);
    g = setItemDueDate(g, PARENT, 'b', NOW + 20 * DAY);
    g = setItemDueDate(g, PARENT, 'c', NOW + 10 * DAY);
    g = setItemDueDate(g, PARENT, 'nolist', NOW + 5 * DAY);

    g = arrangeSelectionOnAxis(g, PARENT, ['a', 'b', 'c', 'nolist'], (i) => {
      const list = checklistFromRaw(i.extra?.checklist);
      return { x: dueDateOfItem(i), y: list.length > 0 ? checklistProgress(list).fraction : null };
    }, { showAxis: true, formatX: dueMsToDateLabel, formatY: (v) => `${Math.round(v * 100)}%`, domainY: { min: 0, max: 1 } });

    const items = readItems(g, PARENT);
    const ticks = items.filter(itemIsAxisTick);
    const xTicks = ticks.filter((t) => t.memberId.startsWith(`${AXIS_TICK_PREFIX}x:`)).map((t) => t.text ?? '');
    const yTicks = ticks.filter((t) => t.memberId.startsWith(`${AXIS_TICK_PREFIX}y:`)).map((t) => t.text ?? '');
    // X labelled with dueMsToDateLabel (dates), Y labelled with the % formatter — DISTINCT per axis:
    expect(xTicks.length).toBeGreaterThanOrEqual(2);
    expect(yTicks.length).toBeGreaterThanOrEqual(2);
    expect(xTicks.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t))).toBe(true);
    expect(yTicks.every((t) => /^\d+%$/.test(t))).toBe(true); // e.g. '0%','50%','100%' — NOT dates
    // the no-checklist card parked below the three plotted cards (y null → no-value pile):
    const y = (id: string) => items.find((it) => it.memberId === id)!.y;
    expect(y('nolist')).toBeGreaterThan(Math.max(y('a'), y('b'), y('c')));
  });
});
