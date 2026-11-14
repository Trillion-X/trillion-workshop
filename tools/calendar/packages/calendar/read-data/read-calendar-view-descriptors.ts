// packages/calendar/read-data/read-calendar-view-descriptors.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The live enumeration boundary for CALENDAR VIEWS. A view (Day, Week, Month,
// Agenda, 3-day, Work week, Schedule, …) is a `calendar-view-descriptor` DATA
// row — NOT a closed TS enum and NOT a per-view `if` in the surface. Each
// descriptor names one of the three Physics-closed time GEOMETRIES (`time-grid`,
// `month-grid`, `agenda-list`) and carries its parameters (how many day columns,
// which hour window, chip density). The surface renders the view picker from
// this list and dispatches the grid body through a geometry registry keyed by
// `layout`. Adding a view = ONE descriptor DATA row, zero surface-code change
// (L069/L090/enum-dissolution).
//
// Deletion test: delete day/week/month/agenda rows, drop `three-day`/`work-week`/
// `schedule` rows → the picker lists them and the body renders them, no code
// change. A "3-day" view the code never named emerges from one data row.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. `layout` is an OPEN string resolved through the injected geometry registry
//    (`show/calendar-view-registry`). An unknown layout is handled as DATA
//    (honest notice), never a crash and never a closed union in the type.
// 2. Transport is the injected `CalendarRequestSender` (pure in tests, real
//    `sendRequestToBitfieldTarget` in the mount) — identical to the lens read.
// 3. `BUILTIN_VIEW_DESCRIPTORS` is the SYNCHRONOUS MIRROR of the package's
//    shipped `calendar-view-descriptor` records in `things-to-store-and-run.json`
//    (SSOT = the TSR rows). It exists only so the view picker + grid paint on
//    the first frame (a calendar with zero views cannot render at all, unlike
//    the block axis which tolerates emptiness). The live read UNIONs any
//    user-authored descriptor rows over it by `view_id`. It is NOT a fallback
//    that papers over a broken feed — keep it byte-identical to the TSR rows.

import type { CalendarRequestSender } from './read-calendar-lens-feeds';
import { rowsFromLensReply } from './read-calendar-lens-feeds';

/** A view = one geometry + its parameters. `layout` is an open key into the
 *  geometry registry; params are read structurally per geometry. */
export type CalendarViewDescriptor = {
  view_id: string;
  label: string;
  /** Open geometry key: 'time-grid' | 'month-grid' | 'agenda-list' | future. */
  layout: string;
  order: number;
  // time-grid params
  day_count?: number;
  window_start_minute?: number;
  window_end_minute?: number;
  hour_height_px?: number;
  skip_weekends?: boolean;
  // month-grid params
  max_chips_per_cell?: number;
};

/** Shipped view set — the synchronous mirror of the `calendar-view-descriptor`
 *  records in things-to-store-and-run.json. Keep in sync with the TSR rows. */
export const BUILTIN_VIEW_DESCRIPTORS: CalendarViewDescriptor[] = [
  { view_id: 'day', label: 'Day', layout: 'time-grid', order: 10, day_count: 1, window_start_minute: 420, window_end_minute: 1260, hour_height_px: 60 },
  { view_id: 'week', label: 'Week', layout: 'time-grid', order: 20, day_count: 7, window_start_minute: 420, window_end_minute: 1260, hour_height_px: 60 },
  { view_id: 'month', label: 'Month', layout: 'month-grid', order: 30, max_chips_per_cell: 3 },
  { view_id: 'agenda', label: 'Agenda', layout: 'agenda-list', order: 40 },
];

export const DEFAULT_VIEW_ID = 'week';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Structural validator for a `calendar-view-descriptor` DATA row. Malformed
 *  rows are dropped by the caller, never thrown on. */
export function parseCalendarViewDescriptor(value: unknown): CalendarViewDescriptor | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'calendar-view-descriptor') return null;
  if (typeof value.view_id !== 'string' || !value.view_id) return null;
  if (typeof value.layout !== 'string' || !value.layout) return null;
  const label = typeof value.label === 'string' && value.label ? value.label : value.view_id;
  const order = optionalNumber(value.order) ?? 1000;
  return {
    view_id: value.view_id,
    label,
    layout: value.layout,
    order,
    day_count: optionalNumber(value.day_count),
    window_start_minute: optionalNumber(value.window_start_minute),
    window_end_minute: optionalNumber(value.window_end_minute),
    hour_height_px: optionalNumber(value.hour_height_px),
    skip_weekends: typeof value.skip_weekends === 'boolean' ? value.skip_weekends : undefined,
    max_chips_per_cell: optionalNumber(value.max_chips_per_cell),
  };
}

/** Union a live descriptor list over the shipped builtins by `view_id`
 *  (live row of the same id wins) and sort by `order` then `label`. Pure — the
 *  render path only ever consumes the result of this function, so a test that
 *  passes arbitrary descriptors proves the zero-source-change property. */
export function mergeViewDescriptors(
  builtins: CalendarViewDescriptor[],
  live: CalendarViewDescriptor[],
): CalendarViewDescriptor[] {
  const byId = new Map<string, CalendarViewDescriptor>();
  for (const descriptor of builtins) byId.set(descriptor.view_id, descriptor);
  for (const descriptor of live) byId.set(descriptor.view_id, descriptor);
  return [...byId.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

/** Read the live `calendar-view-descriptor` DATA rows through the injected
 *  sender — same mechanism as the lens read. */
export async function readCalendarViewDescriptors(
  sender: CalendarRequestSender,
): Promise<CalendarViewDescriptor[]> {
  const reply = await sender({
    target: 'slot::find-current-items',
    payload: {
      operation: 'find-current-items',
      in: 'calendar-view-descriptor',
      where: { all: [{ field: 'kind', in: ['calendar-view-descriptor'] }] },
    },
  });
  return rowsFromLensReply(reply)
    .map(parseCalendarViewDescriptor)
    .filter((descriptor): descriptor is CalendarViewDescriptor => descriptor !== null);
}
