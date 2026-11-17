// packages/calendar/show/calendar-view-registry.tsx
//
// The CALENDAR GEOMETRY REGISTRY. There are exactly three Physics-closed ways to
// project a set of time intervals onto a 2-D plane, and each is a generic,
// domain-blind renderer parameterized by a `calendar-view-descriptor` DATA row:
//
//   time-grid   → rows = hours, columns = N days, blocks positioned + scaled by
//                 duration           (Amie week/day — refs A,B,C)
//   month-grid  → a 6×7 day-bucket matrix, chip stack per cell + "N more"
//                 (Fantastical/Cron month — refs F,G)
//   agenda-list → a chronological, day-grouped list
//                 (refs H)
//
// This registry IS the injected capability map (enum-dissolution): the surface
// never writes `if (viewMode === 'month')`. It looks up `descriptor.layout` and
// dispatches. Society extensibility — infinitely many NAMED views (Day, Week,
// 3-day, Work week, Schedule, Quarter, …) — lives entirely in the descriptor
// DATA; adding one is a data row, zero change here. The three geometry keys are
// Physics-closed like Option/Result: a user adds VIEWS, never a new way to draw
// time. An unrecognized `layout` is handled as DATA (an honest notice), never a
// crash and never a closed union.

import React from 'react';
import { Container } from '../../../../ui/show/container';
import { Text } from '../../../../ui/show/text';
import type { CalendarViewDescriptor } from '../read-data/read-calendar-view-descriptors';
import { CalendarAgenda } from './CalendarAgenda';
import { CalendarMonthView } from './CalendarMonthView';
import { CalendarTimeGrid } from './CalendarTimeGrid';
import type { CalendarActionModel, CalendarScreenModel } from './calendar-screen-model';

export type CalendarViewRenderArgs = {
  model: CalendarScreenModel;
  descriptor: CalendarViewDescriptor;
  onAction: (action: CalendarActionModel, source?: Record<string, unknown>) => void;
  onSelectBlock: (blockId: string) => void;
};

export type CalendarViewRenderer = (args: CalendarViewRenderArgs) => React.ReactNode;

/** The Physics-closed geometry primitives. Adding a geometry (rare, engine-level)
 *  registers a leaf here; adding a VIEW is a DATA descriptor row, not a change. */
export const CALENDAR_VIEW_LAYOUTS: Record<string, CalendarViewRenderer> = {
  'time-grid': ({ model, descriptor, onSelectBlock }) => (
    <CalendarTimeGrid model={model} descriptor={descriptor} onSelectBlock={onSelectBlock} />
  ),
  'month-grid': ({ model, descriptor, onSelectBlock }) => (
    <CalendarMonthView model={model} descriptor={descriptor} onSelectBlock={onSelectBlock} />
  ),
  'agenda-list': ({ model, onAction, onSelectBlock }) => (
    <CalendarAgenda model={model} onAction={onAction} onSelectBlock={onSelectBlock} />
  ),
};

function UnknownLayoutNotice({ layout }: { layout: string }) {
  return (
    <Container layout="vertical" gap="sm" padding="lg" border="all" rounded="md" background="secondary" data-calendar-unknown-layout={layout}>
      <Text variant="heading-xs">This view isn&apos;t available yet.</Text>
      <Text variant="body-xs" color="muted">Pick another view above.</Text>
    </Container>
  );
}

/** Dispatch the active view descriptor through the geometry registry. The single
 *  replacement for every `if (view === …)` the surface used to carry. */
export function renderCalendarView(args: CalendarViewRenderArgs): React.ReactNode {
  const renderer = CALENDAR_VIEW_LAYOUTS[args.descriptor.layout];
  if (!renderer) return <UnknownLayoutNotice layout={args.descriptor.layout} />;
  return renderer(args);
}
