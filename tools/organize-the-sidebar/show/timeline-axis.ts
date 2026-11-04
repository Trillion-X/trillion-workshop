// packages/group/show/timeline-axis.ts
//
// TIMELINE AXIS — the surface bridge that turns b114's `date-scale` leaf into a real board TIMELINE by feeding
// it to the EXISTING axis engine (`arrange-by-axis`), with ZERO new placement code (L030 reuse). A timeline is
// just the number-line arrange whose value is a PARSED DATE and whose ticks are DATE-ALIGNED instead of
// 1/2/5×10ⁿ round numbers. `timelineAxisItems` maps each board item to an `AxisItem` (valueX = the parsed date,
// null → parks in the engine's no-value pile); `timelineTickMarks` produces the dated axis furniture (labelled
// ticks at day/week/month/quarter/year boundaries) positioned with the SAME linear scale `axisPlot` uses, so
// the labels line up with the placed cards. WHICH date field is the caller's injected `dateOf` — the
// `TIMELINE_DATE_FIELDS` catalog carries the common ones as DATA (a new field is one row, L090).

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import type { AxisItem, AxisExtent } from './arrange-by-axis';
import { parseFlexibleDate, niceDateTicks, formatDateTick } from '../do-work/date-scale';

/** A selectable date field — DATA (the reader is injected; the bridge never names "dueDate"). */
export interface TimelineDateField {
  readonly id: string;
  readonly label: string;
  readonly dateOf: (item: BoardItem) => unknown;
}

const readExtra = (key: string) => (item: BoardItem) => item.extra?.[key];

export const TIMELINE_DATE_FIELDS: readonly TimelineDateField[] = [
  { id: 'due', label: 'Timeline by due date', dateOf: readExtra('dueDate') },
  { id: 'created', label: 'Timeline by created date', dateOf: readExtra('createdAt') },
  { id: 'scheduled', label: 'Timeline by scheduled date', dateOf: readExtra('scheduledFor') },
];

export function timelineFieldById(id: string | undefined): TimelineDateField {
  return TIMELINE_DATE_FIELDS.find((f) => f.id === id) ?? TIMELINE_DATE_FIELDS[0];
}

/** Board items → axis items keyed on the parsed date (unparseable → valueX null → parks). Connectors excluded. */
export function timelineAxisItems(items: readonly BoardItem[], dateOf: (item: BoardItem) => unknown): AxisItem[] {
  return items
    .filter((i) => !itemIsConnector(i))
    .map((i) => ({ memberId: i.memberId, w: i.w, h: i.h, valueX: parseFlexibleDate(dateOf(i)) }));
}

/** The parsed-date domain (min/max ms), or null when no item has a date. */
export function timelineDomain(items: readonly BoardItem[], dateOf: (item: BoardItem) => unknown): AxisExtent | null {
  let min = Infinity;
  let max = -Infinity;
  let any = false;
  for (const i of items) {
    if (itemIsConnector(i)) continue;
    const ts = parseFlexibleDate(dateOf(i));
    if (ts === null) continue;
    any = true;
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }
  return any ? { min, max } : null;
}

/** One labelled timeline mark: its date label + pixel position along the axis. */
export interface TimelineMark {
  readonly ts: number;
  readonly label: string;
  readonly pos: number;
}

export interface TimelineTickOptions {
  readonly dateOf: (item: BoardItem) => unknown;
  readonly originX?: number;
  readonly spanX?: number;
  readonly target?: number;
}

/**
 * The dated axis marks for a timeline over `items` — `niceDateTicks` across the parsed-date domain, each
 * positioned with the SAME linear scale `axisPlot` uses (so a mark lines up with the card on that date). Empty
 * when no item has a date (nothing to timeline). Deterministic.
 */
export function timelineTickMarks(items: readonly BoardItem[], opts: TimelineTickOptions): TimelineMark[] {
  const domain = timelineDomain(items, opts.dateOf);
  if (domain === null) return [];
  const originX = Number.isFinite(opts.originX) ? (opts.originX as number) : 0;
  const spanX = Number.isFinite(opts.spanX) && (opts.spanX as number) > 0 ? (opts.spanX as number) : 800;
  const d = domain.max - domain.min;
  // Same rule as arrange-by-axis' private linScale: a degenerate/non-finite domain pins to the range start.
  const posOf = (ts: number) => (d > 0 && Number.isFinite(d) ? originX + ((ts - domain.min) / d) * spanX : originX);
  return niceDateTicks(domain.min, domain.max, opts.target ?? 6).map((t) => ({
    ts: t.ts,
    label: formatDateTick(t.ts, t.granularity),
    pos: posOf(t.ts),
  }));
}
