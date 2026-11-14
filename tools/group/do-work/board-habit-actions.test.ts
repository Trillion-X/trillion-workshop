// Proof for the habit GRAPH bridge: logs co-locate on the item as extra.habitLog, toggle-today flows
// through patchItem preserving other extra, an emptied log clears the field, connectors + furniture are
// never targets, streakRows rank by current streak with labels.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { dayStart } from '../read-data/board-habit';
import { periodStartOf, prevPeriodStart } from '../read-data/board-habit-cadence';
import {
  boardHabits,
  cadenceOfItem,
  habitBadgeOf,
  habitCadenceOf,
  habitLogOf,
  itemIsHabitTarget,
  itemStreak,
  setHabitCadence,
  streakRows,
  toggleHabitToday,
} from './board-habit-actions';

const DAY = 86_400_000;
const TODAY = dayStart(1_760_000_000_000);
const NOW = TODAY + 15 * 3_600_000;
const YESTERDAY = NOW - DAY;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };

function board() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
  put({ memberId: 'meditate', kind: 'note', x: 0, y: 0, text: 'Meditate', extra: { fill: '#fff' } });
  put({ memberId: 'run', kind: 'note', x: 200, y: 0, text: 'Run' });
  put({ memberId: 'edge', kind: 'connector', x: 0, y: 0, extra: { fromMemberId: 'meditate', toMemberId: 'run' } });
  put({ memberId: `${AXIS_TICK_PREFIX}x:10`, kind: 'note', x: 0, y: 400, text: '10', extra: { axisTick: true } });
  return g;
}

describe('board-habit-actions — the graph bridge', () => {
  it('toggle-today stores the log on the item as extra.habitLog, preserving other extra; emptying clears', () => {
    let g = board();
    g = toggleHabitToday(g, PARENT, 'meditate', NOW);
    const item = readItems(g, PARENT).find((it) => it.memberId === 'meditate')!;
    expect(habitLogOf(g, PARENT, 'meditate')).toEqual([dayStart(NOW)]);
    expect(item.extra.fill).toBe('#fff'); // other extra untouched
    expect(itemStreak(g, PARENT, 'meditate', NOW)).toBe(1);
    // toggling today off empties the log → the field is cleared
    g = toggleHabitToday(g, PARENT, 'meditate', NOW);
    expect(habitLogOf(g, PARENT, 'meditate')).toEqual([]);
    expect(readItems(g, PARENT).find((it) => it.memberId === 'meditate')!.extra.habitLog).toBeUndefined();
  });

  it('a multi-day streak builds via successive day logs', () => {
    let g = board();
    g = toggleHabitToday(g, PARENT, 'meditate', YESTERDAY);
    g = toggleHabitToday(g, PARENT, 'meditate', NOW);
    expect(itemStreak(g, PARENT, 'meditate', NOW)).toBe(2);
  });

  it('boardHabits + itemIsHabitTarget exclude connectors and furniture', () => {
    let g = board();
    g = toggleHabitToday(g, PARENT, 'meditate', NOW);
    const items = readItems(g, PARENT);
    const byId = (id: string) => items.find((it) => it.memberId === id)!;
    expect(itemIsHabitTarget(byId('meditate'))).toBe(true);
    expect(itemIsHabitTarget(byId('edge'))).toBe(false);
    expect(itemIsHabitTarget(byId(`${AXIS_TICK_PREFIX}x:10`))).toBe(false);
    expect(boardHabits(items).map((h) => h.id)).toEqual(['meditate']); // only 'meditate' has a log
  });

  it('streakRows rank by current streak with item labels', () => {
    let g = board();
    g = toggleHabitToday(g, PARENT, 'meditate', YESTERDAY);
    g = toggleHabitToday(g, PARENT, 'meditate', NOW); // streak 2
    g = toggleHabitToday(g, PARENT, 'run', NOW); // streak 1
    const rows = streakRows(readItems(g, PARENT), NOW);
    expect(rows.map((r) => r.memberId)).toEqual(['meditate', 'run']);
    expect(rows[0].label).toBe('Meditate');
    expect(rows.map((r) => r.streak)).toEqual([2, 1]);
  });

  it('a cadence habit (3x/week) reports period progress + a period streak, not a day streak', () => {
    const WK = periodStartOf(NOW, 'week');
    const WK_1 = prevPeriodStart(WK, 'week');
    let g = emptyGraph();
    const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
    // 'gym' = 3x/week: 2 done this week (in progress) + a full 3 last week -> period streak 1, progress 2/3.
    put({ memberId: 'gym', kind: 'note', x: 0, y: 0, text: 'Gym', extra: { habitCadence: { period: 'week', times: 3 }, habitLog: [WK, WK + DAY, WK_1, WK_1 + DAY, WK_1 + 2 * DAY] } });
    const item = readItems(g, PARENT).find((it) => it.memberId === 'gym')!;
    expect(cadenceOfItem(item)).toEqual({ period: 'week', times: 3 });
    const row = streakRows(readItems(g, PARENT), NOW).find((r) => r.memberId === 'gym')!;
    expect(row.cadence).toEqual({ label: '3x per week', done: 2, target: 3, met: false, period: 'week' });
    expect(row.streak).toBe(1); // last week met; this week in progress (not counted against)
  });

  it('a habit with no cadence keeps the exact daily behaviour (zero regression)', () => {
    let g = board();
    g = toggleHabitToday(g, PARENT, 'run', NOW);
    const row = streakRows(readItems(g, PARENT), NOW).find((r) => r.memberId === 'run')!;
    expect(row.cadence).toBeUndefined();
    expect(row.streak).toBe(1);
  });

  it('habitBadgeOf is cadence-aware: a 3x/week habit reports period progress (not a false daily 0)', () => {
    const WK = periodStartOf(NOW, 'week');
    const WK_1 = prevPeriodStart(WK, 'week');
    let g = emptyGraph();
    const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, ...a } as never));
    // 3x/week, met this week (gapped) + last week -> streak 2, done 3/3 this week, no false daily-0.
    put({ memberId: 'gym', kind: 'note', x: 0, y: 0, text: 'Gym', extra: { habitCadence: { period: 'week', times: 3 }, habitLog: [WK, WK + 2 * DAY, WK + 4 * DAY, WK_1, WK_1 + DAY, WK_1 + 2 * DAY] } });
    put({ memberId: 'plain', kind: 'note', x: 200, y: 0, text: 'Meditate', extra: { habitLog: [dayStart(NOW)] } }); // daily, streak 1
    const items = readItems(g, PARENT);
    const gym = habitBadgeOf(items.find((it) => it.memberId === 'gym')!, NOW)!;
    expect(gym.streak).toBe(2);
    expect(gym.cadence).toEqual({ done: 3, target: 3, met: true, period: 'week' });
    const plain = habitBadgeOf(items.find((it) => it.memberId === 'plain')!, NOW)!;
    expect(plain.streak).toBe(1);
    expect(plain.cadence).toBeUndefined(); // daily habit — no cadence readout
    // a card with no habit log is not a habit badge
    put({ memberId: 'idle', kind: 'note', x: 400, y: 0, text: 'Someday' });
    expect(habitBadgeOf(readItems(g, PARENT).find((it) => it.memberId === 'idle')!, NOW)).toBeNull();
  });

  it('setHabitCadence round-trips through patchItem: set -> read -> clear, preserving other extra', () => {
    let g = board();
    g = toggleHabitToday(g, PARENT, 'meditate', NOW); // has habitLog + extra.fill
    g = setHabitCadence(g, PARENT, 'meditate', { period: 'week', times: 3 });
    expect(habitCadenceOf(g, PARENT, 'meditate')).toEqual({ period: 'week', times: 3 });
    expect(readItems(g, PARENT).find((it) => it.memberId === 'meditate')!.extra.fill).toBe('#fff'); // untouched
    expect(readItems(g, PARENT).find((it) => it.memberId === 'meditate')!.extra.habitLog).toBeDefined(); // log untouched
    g = setHabitCadence(g, PARENT, 'meditate', null); // clear -> back to daily
    expect(habitCadenceOf(g, PARENT, 'meditate')).toBeNull();
    expect(readItems(g, PARENT).find((it) => it.memberId === 'meditate')!.extra.habitCadence).toBeUndefined();
  });
});
