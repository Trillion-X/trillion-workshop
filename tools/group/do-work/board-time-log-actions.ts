// packages/group/do-work/board-time-log-actions.ts
//
// The GRAPH bridge for the time-log primitive (read-data/board-time-log): read an item's work sessions
// as self-describing DATA, append/remove/clear them through the ONE tested `patchItem` write path, and
// reduce the board to effort rankings. A log lives ON the item as `extra.timeLog` (co-locates → moves +
// deletes with the item, rides along in shares/templates via the existing `extra` preservation).
// Connectors + auto furniture are never effort targets — you track work on CONTENT, not the scaffolding.
// It also COMPOSES with the metric primitive into velocity (progress-per-hour) without a new engine.

import type { GroupGraph, AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { BoardItem } from '../read-data/group-board-model';
import { readItems, patchItem, itemIsConnector } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import {
  type TimeLog,
  type TimeSession,
  progressPerHour,
  rankByRecentTime,
  rankByTotalTime,
  timeInWindowMs,
  timeLogFromRaw,
  totalDurationMs,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-time-log.ts';
import { fraction, metricFromRaw, startOf } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-metric.ts';

/** An item is an effort TARGET iff it is real content, not a connector or furniture. */
export function itemIsTimeTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** The time log on one item (empty when none / malformed). */
export function timeLogOfItem(item: BoardItem): TimeLog {
  return timeLogFromRaw(item.extra?.timeLog);
}

/** Read one item's time log from the live graph (empty if absent). */
export function timeLogOf(graph: GroupGraph, ref: AddressRef, memberId: string): TimeLog {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? timeLogOfItem(item) : [];
}

/** Write a normalized log back onto the item (empty log clears the field). */
function writeLog(graph: GroupGraph, ref: AddressRef, memberId: string, log: TimeLog): GroupGraph {
  return patchItem(graph, ref, memberId, { timeLog: log.length > 0 ? log : undefined });
}

/** Append one COMPLETED session. A non-positive duration is a no-op (nothing to log). */
export function logSession(graph: GroupGraph, ref: AddressRef, memberId: string, session: TimeSession): GroupGraph {
  if (!(session.durationMs > 0) || !(session.startMs > 0)) return graph;
  const next = [...timeLogOf(graph, ref, memberId), { startMs: session.startMs, durationMs: session.durationMs }];
  return writeLog(graph, ref, memberId, timeLogFromRaw(next));
}

/** Convenience: log `minutes` of work ending at `now` (the "+25m" quick-add). */
export function logMinutes(graph: GroupGraph, ref: AddressRef, memberId: string, minutes: number, now: number): GroupGraph {
  if (!(minutes > 0)) return graph;
  const durationMs = Math.round(minutes * 60000);
  return logSession(graph, ref, memberId, { startMs: now - durationMs, durationMs });
}

/** Undo the most recent session (by start) — a mis-log escape hatch. */
export function removeLastSession(graph: GroupGraph, ref: AddressRef, memberId: string): GroupGraph {
  const log = timeLogOf(graph, ref, memberId);
  if (log.length === 0) return graph;
  return writeLog(graph, ref, memberId, log.slice(0, -1));
}

/** Clear all sessions from an item. */
export function clearTimeLog(graph: GroupGraph, ref: AddressRef, memberId: string): GroupGraph {
  return writeLog(graph, ref, memberId, []);
}

/** An item paired with its log — the input to a total-time overlay. */
export interface TimeLogItem {
  readonly id: string;
  readonly log: TimeLog;
}

/** Every effort target that HAS sessions, paired with its log. */
export function boardTimeLogs(items: readonly BoardItem[]): TimeLogItem[] {
  const out: TimeLogItem[] = [];
  for (const it of items) {
    if (!itemIsTimeTarget(it)) continue;
    const log = timeLogOfItem(it);
    if (log.length > 0) out.push({ id: it.memberId, log });
  }
  return out;
}

/** One effort-ranking row: the item + a human label + the ranked milliseconds + session count. */
export interface TimeRankRow {
  readonly memberId: string;
  readonly label: string;
  readonly ms: number;
  readonly sessions: number;
}

function labelOf(items: readonly BoardItem[]): (id: string) => string {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  return (id: string): string => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
}

/**
 * Effort-ranking rows. `mode: 'total'` = most time invested overall; `mode: 'recent'` = most time in the
 * trailing `windowMs` ending at `now`. `now`/`windowMs` are only read in 'recent' mode. Pure read-model.
 */
export function timeRows(
  items: readonly BoardItem[],
  mode: 'total' | 'recent' = 'total',
  now = 0,
  windowMs = 7 * 24 * 3_600_000,
): TimeRankRow[] {
  const label = labelOf(items);
  const targets = items.filter(itemIsTimeTarget);
  const logOf = (it: BoardItem): TimeLog => timeLogOfItem(it);
  const ranked = mode === 'recent' ? rankByRecentTime(targets, logOf, now, windowMs) : rankByTotalTime(targets, logOf);
  return ranked.map((r): TimeRankRow => ({ memberId: r.item.memberId, label: label(r.item.memberId), ms: r.ms, sessions: r.log.length }));
}

/**
 * Velocity composition (L069): an item's progress-per-hour = its metric's progressed units / total hours
 * logged. Null when the item has no metric or no logged time. Reads BOTH extra.metric and extra.timeLog
 * — the two primitives compose without a new engine.
 */
export function velocityPerHourOfItem(item: BoardItem): number | null {
  const metric = metricFromRaw(item.extra?.metric);
  if (metric === null) return null;
  // Progressed units = distance moved from the baseline toward the target (magnitude, direction-agnostic
  // so a descending goal like debt-reduction reports positive velocity). fraction<0 means moved away → 0.
  const units = fraction(metric) <= 0 ? 0 : Math.abs(metric.current - startOf(metric));
  return progressPerHour(units, totalDurationMs(timeLogOfItem(item)));
}

/** Graph-addressed velocity — the same composition, resolving the item by id first. */
export function itemVelocityPerHour(graph: GroupGraph, ref: AddressRef, memberId: string): number | null {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? velocityPerHourOfItem(item) : null;
}

/** Convenience: total time on one item (ms) — the header/overlay readout source. */
export function totalTimeOf(graph: GroupGraph, ref: AddressRef, memberId: string): number {
  return totalDurationMs(timeLogOf(graph, ref, memberId));
}

/** Convenience re-export for callers building a "recent" overlay without importing the leaf. */
export { timeInWindowMs };
