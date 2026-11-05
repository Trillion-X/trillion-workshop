// packages/group/do-work/board-forecast-actions.ts
//
// The GRAPH bridge for the forecast primitive (read-data/board-forecast): pull an item's metric distance,
// its logged pace, and its due date — three self-describing DATA facets already on the item — and hand them
// to the blind `forecast` engine. It owns NO projection math (that is the leaf) and NO new storage: a
// forecast is always DERIVED, never persisted (SSOT — the metric + time-log + due date are the only truth).
// A forecast target is an item carrying a metric (there is nothing to project a finish for without a goal);
// connectors + auto furniture are never targets. Composes three primitives with no new engine (L063/L069).

import type { GroupGraph, AddressRef } from '../../ui/show/group/group-graph';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { readItems, itemIsConnector } from '../read-data/group-board-model.ts';
import { itemIsBoardFurniture } from './batch-actions.ts';
import { metricFromRaw, remaining } from '../read-data/board-metric.ts';
import { dueDateFromRaw } from '../read-data/board-due-date.ts';
import { velocityPerHourOfItem } from './board-time-log-actions.ts';
import { forecast, compareForecasts, type Forecast } from '../read-data/board-forecast.ts';

/** An item is a forecast TARGET iff it carries a metric and is real content (not a connector/furniture). */
export function itemIsForecastTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item) && metricFromRaw(item.extra?.metric) !== null;
}

/** Project one item's finish at `now` — null when it has no metric (nothing to forecast). */
export function forecastOfItem(item: BoardItem, now: number): Forecast | null {
  const metric = metricFromRaw(item.extra?.metric);
  if (metric === null) return null;
  return forecast({
    remainingUnits: remaining(metric),
    velocityPerHour: velocityPerHourOfItem(item),
    now,
    due: dueDateFromRaw(item.extra?.dueDate),
  });
}

/** Graph-addressed convenience — resolve the item by id, then project. */
export function forecastOf(graph: GroupGraph, ref: AddressRef, memberId: string, now: number): Forecast | null {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? forecastOfItem(item, now) : null;
}

/** One forecast row: the item, a display label, and its projection. */
export interface ForecastRow {
  readonly memberId: string;
  readonly label: string;
  readonly forecast: Forecast;
}

/** Every goal on the board with its projection, ordered risk-first (behind/stalled before ahead/complete). */
export function forecastRows(items: readonly BoardItem[], now: number): ForecastRow[] {
  const rows: ForecastRow[] = [];
  for (const item of items) {
    if (!itemIsForecastTarget(item)) continue;
    const f = forecastOfItem(item, now);
    if (f !== null) rows.push({ memberId: item.memberId, label: item.text?.trim() || item.memberId, forecast: f });
  }
  return rows.sort((a, b) => compareForecasts(a.forecast, b.forecast));
}

/** Board-level tally for the panel header: how many goals are at risk (behind/stalled) vs on pace. */
export interface ForecastSummary {
  readonly total: number;
  readonly atRisk: number;
  readonly onPace: number;
  readonly complete: number;
}

export function boardForecastSummary(items: readonly BoardItem[], now: number): ForecastSummary {
  const rows = forecastRows(items, now);
  let atRisk = 0;
  let onPace = 0;
  let complete = 0;
  for (const r of rows) {
    const v = r.forecast.verdict;
    if (v === 'behind' || v === 'stalled') atRisk += 1;
    else if (v === 'complete') complete += 1;
    else onPace += 1;
  }
  return { total: rows.length, atRisk, onPace, complete };
}
