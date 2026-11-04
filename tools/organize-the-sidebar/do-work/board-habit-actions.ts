// packages/group/do-work/board-habit-actions.ts
//
// The GRAPH bridge for the habit primitive (read-data/board-habit): read an item's completion log as
// self-describing DATA, toggle today's completion through the ONE tested `patchItem` write path, and
// reduce the board to a streak ranking. A habit log lives ON the item as `extra.habitLog` (co-locates →
// moves + deletes with the item, rides along in shares/templates via the existing `extra` preservation).
// Connectors + auto furniture are never habit targets — you track CONTENT, not the board's scaffolding.

import type { GroupGraph, AddressRef } from '../../ui/show/group/group-graph';
import type { BoardItem } from '../read-data/group-board-model';
import { readItems, patchItem, itemIsConnector } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import {
  type HabitItem,
  type HabitLog,
  EMPTY_LOG,
  currentStreak,
  habitLogFromRaw,
  isLoggedOn,
  toggleDay,
} from '../read-data/board-habit';
import {
  type Cadence,
  type CadencePeriod,
  cadenceFromRaw,
  cadenceStreak,
  currentPeriodProgress,
  cadenceLabel,
  habitPulse,
} from '../read-data/board-habit-cadence';

/** An item is a habit TARGET iff it is real content, not a connector or furniture. */
export function itemIsHabitTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** The normalized habit log on one item (EMPTY_LOG when it has none / a malformed value). */
export function habitLogOfItem(item: BoardItem): HabitLog {
  return habitLogFromRaw(item.extra?.habitLog);
}

/** Read one item's habit log from the live graph. */
export function habitLogOf(graph: GroupGraph, ref: AddressRef, memberId: string): HabitLog {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? habitLogOfItem(item) : EMPTY_LOG;
}

/**
 * Toggle today's completion for an item (creating the habit on the first log). `now` is injected; the
 * day is floored to its UTC-day inside the leaf. Written back via `patchItem`, which merges into the
 * item's presentation, so every other `extra` field is preserved.
 */
export function toggleHabitToday(graph: GroupGraph, ref: AddressRef, memberId: string, now: number): GroupGraph {
  const next = toggleDay(habitLogOf(graph, ref, memberId), now);
  // An empty log clears the field entirely (the item stops being a tracked habit → no badge).
  return patchItem(graph, ref, memberId, { habitLog: next.length > 0 ? next : undefined });
}

/** Every habit target that HAS a log, paired with it. */
export function boardHabits(items: readonly BoardItem[]): HabitItem[] {
  const out: HabitItem[] = [];
  for (const it of items) {
    if (!itemIsHabitTarget(it)) continue;
    const log = habitLogOfItem(it);
    if (log.length > 0) out.push({ id: it.memberId, log });
  }
  return out;
}

/** The target frequency set on one item (`extra.habitCadence`), or null → the daily-streak path. */
export function cadenceOfItem(item: BoardItem): Cadence | null {
  return cadenceFromRaw(item.extra?.habitCadence);
}

/** Read one item's cadence from the live graph. */
export function habitCadenceOf(graph: GroupGraph, ref: AddressRef, memberId: string): Cadence | null {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? cadenceOfItem(item) : null;
}

/** The on-card / toolbar habit readout — the ONE cadence-aware badge every habit-DISPLAY surface shares, so
 *  a non-daily habit never shows a false "🔥 0" for lacking consecutive days. `streak` is cadence-aware
 *  (periods for a cadence habit, days for daily); `cadence` (present only for a cadence habit) carries this
 *  period's progress for a "N of M" readout. Null when the item is not a tracked habit. */
export interface HabitBadge {
  readonly streak: number;
  readonly loggedToday: boolean;
  readonly cadence?: { readonly done: number; readonly target: number; readonly met: boolean; readonly period: CadencePeriod };
}

export function habitBadgeOf(item: BoardItem, now: number): HabitBadge | null {
  const log = habitLogOfItem(item);
  if (log.length === 0) return null;
  const cad = cadenceOfItem(item);
  const streak = habitPulse(log, cad, now).streak;
  const loggedToday = isLoggedOn(log, now);
  if (cad === null) return { streak, loggedToday };
  const prog = currentPeriodProgress(log, cad, now);
  return { streak, loggedToday, cadence: { done: prog.done, target: prog.target, met: prog.met, period: cad.period } };
}

/**
 * Set (or clear, with `null`) a habit's cadence — co-located on the item as `extra.habitCadence` via the
 * ONE `patchItem` path, so it moves/shares/deletes with the habit and preserves every other `extra` field.
 * Clearing returns the habit to the daily-streak path.
 */
export function setHabitCadence(graph: GroupGraph, ref: AddressRef, memberId: string, cadence: Cadence | null): GroupGraph {
  return patchItem(graph, ref, memberId, { habitCadence: cadence ?? undefined });
}

/** The cadence readout attached to a streak row when the habit has a non-daily target. */
export interface CadenceReadout {
  readonly label: string; // "3x per week"
  readonly done: number; // completions in the current period
  readonly target: number; // the period target
  readonly met: boolean; // this period already satisfied
  readonly period: CadencePeriod;
}

/** One "Streaks" row: the item + a human label + its streak (days, or PERIODS for a cadence habit). */
export interface StreakRankRow {
  readonly memberId: string;
  readonly label: string;
  readonly streak: number;
  /** Present iff the habit has a cadence — the panel then shows "N of M this week" instead of a day streak. */
  readonly cadence?: CadenceReadout;
}

/**
 * The streak-ranking rows (longest streak first) with each item's own text as its label — the DATA behind a
 * "Streaks" panel with jump-to. `now` is injected. Cadence-aware: a habit with `extra.habitCadence` reports
 * its PERIOD streak (consecutive weeks/months meeting target) + this period's progress, and appears while
 * it has any progress this period even before a streak forms; a habit with no cadence keeps the exact daily
 * behaviour (current streak > 0). Pure read-model.
 */
export function streakRows(items: readonly BoardItem[], now: number): StreakRankRow[] {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  const label = (id: string): string => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
  const rows: StreakRankRow[] = [];
  for (const it of items) {
    if (!itemIsHabitTarget(it)) continue;
    const log = habitLogOfItem(it);
    if (log.length === 0) continue;
    const cad = cadenceOfItem(it);
    if (cad !== null) {
      const streak = cadenceStreak(log, cad, now);
      const prog = currentPeriodProgress(log, cad, now);
      if (streak > 0 || prog.done > 0) {
        rows.push({
          memberId: it.memberId,
          label: label(it.memberId),
          streak,
          cadence: { label: cadenceLabel(cad), done: prog.done, target: prog.target, met: prog.met, period: cad.period },
        });
      }
    } else {
      const streak = currentStreak(log, now);
      if (streak > 0) rows.push({ memberId: it.memberId, label: label(it.memberId), streak });
    }
  }
  return rows.sort((a, b) => b.streak - a.streak);
}

/** Convenience for a badge: current streak for one item in the live graph at `now`. */
export function itemStreak(graph: GroupGraph, ref: AddressRef, memberId: string, now: number): number {
  return currentStreak(habitLogOf(graph, ref, memberId), now);
}
