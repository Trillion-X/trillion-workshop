// packages/group/do-work/board-metric-actions.ts
//
// The GRAPH bridge for the metric primitive (read-data/board-metric): read an item's target metric as
// self-describing DATA, set/clear/bump it through the ONE tested `patchItem` write path, and reduce the
// board to a progress ranking. A metric lives ON the item as `extra.metric` (co-locates → moves +
// deletes with the item, rides along in shares/templates via the existing `extra` preservation).
// Connectors + auto furniture are never metric targets — you measure CONTENT, not the board's scaffolding.

import type { GroupGraph, AddressRef } from '../../ui/show/group/group-graph';
import type { BoardItem } from '../read-data/group-board-model';
import { readItems, patchItem, itemIsConnector } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import {
  type Metric,
  addToCurrent,
  completion,
  isComplete as isMetricComplete,
  metricFromRaw,
  progressPct,
  rankByProgress,
} from '../read-data/board-metric';

/** An item is a metric TARGET iff it is real content, not a connector or furniture. */
export function itemIsMetricTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** The metric on one item (null when none / malformed). */
export function metricOfItem(item: BoardItem): Metric | null {
  return metricFromRaw(item.extra?.metric);
}

/** Read one item's metric from the live graph (null if absent). */
export function metricOf(graph: GroupGraph, ref: AddressRef, memberId: string): Metric | null {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? metricOfItem(item) : null;
}

/** Set (or clear with null) an item's metric. */
export function setItemMetric(graph: GroupGraph, ref: AddressRef, memberId: string, metric: Metric | null): GroupGraph {
  return patchItem(graph, ref, memberId, { metric: metric ?? undefined });
}

/**
 * Move an item's current value by a delta (the +/- progress step). No-op if the item has no metric yet
 * (you set a target first). Goes through the same tested write path.
 */
export function bumpItemMetric(graph: GroupGraph, ref: AddressRef, memberId: string, delta: number): GroupGraph {
  const metric = metricOf(graph, ref, memberId);
  if (metric === null) return graph;
  return setItemMetric(graph, ref, memberId, addToCurrent(metric, delta));
}

/** An item paired with its metric — the input to boardMetrics / a progress overlay. */
export interface MetricItem {
  readonly id: string;
  readonly metric: Metric;
}

/** Every metric target that HAS a metric, paired with it. */
export function boardMetrics(items: readonly BoardItem[]): MetricItem[] {
  const out: MetricItem[] = [];
  for (const it of items) {
    if (!itemIsMetricTarget(it)) continue;
    const metric = metricOfItem(it);
    if (metric !== null) out.push({ id: it.memberId, metric });
  }
  return out;
}

/** One progress-ranking row: the item + a human label + its metric + completion percent. */
export interface MetricRankRow {
  readonly memberId: string;
  readonly label: string;
  readonly metric: Metric;
  readonly pct: number;
}

/**
 * The progress-ranking rows with each item's own text as its label — the DATA behind a progress list
 * with jump-to. `descending` (default) = most complete first ("almost there"); false = least complete
 * first ("needs the most work"). Pure read-model over `boardMetrics` + the leaf's `rankByProgress`.
 */
export function metricRows(items: readonly BoardItem[], descending = true): MetricRankRow[] {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  const label = (id: string): string => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
  return rankByProgress(boardMetrics(items), (mi) => mi.metric, descending).map(
    (r): MetricRankRow => ({ memberId: r.item.id, label: label(r.item.id), metric: r.metric, pct: progressPct(r.metric) }),
  );
}

/** The whole-board metric rollup: how many goals are tracked, how many are complete, and the mean percent. */
export interface MetricSummary {
  readonly tracked: number;
  readonly complete: number;
  readonly avgPct: number;
}

/**
 * Reduce every measured card to a board-level summary — the DATA behind a header "N goals · M done · K%
 * avg" readout. `avgPct` is the mean completion across tracked goals (0 when none). Pure read-model.
 */
export function boardMetricSummary(items: readonly BoardItem[]): MetricSummary {
  const metrics = boardMetrics(items);
  const tracked = metrics.length;
  if (tracked === 0) return { tracked: 0, complete: 0, avgPct: 0 };
  let complete = 0;
  let completionSum = 0; // sum of EXACT completions (0..1) — averaging display-rounded percents double-rounds
  for (const m of metrics) {
    completionSum += completion(m.metric);
    if (isMetricComplete(m.metric)) complete += 1;
  }
  return { tracked, complete, avgPct: Math.round((completionSum / tracked) * 100) };
}
