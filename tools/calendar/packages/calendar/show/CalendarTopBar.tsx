import React from 'react';
import { Button } from '../../../../ui/show/button';
import { Container } from '../../../../ui/show/container';
import { SegmentedControl } from '../../../../ui/show/segmented-control';
import { Text } from '../../../../ui/show/text';
import { calendarControlDisabledReason } from './calendar-screen-model';
import type { CalendarActionModel, CalendarScreenModel } from './calendar-screen-model';

export function CalendarTopBar({
  model,
  onViewChange,
  onAction,
}: {
  model: CalendarScreenModel;
  onViewChange: (viewId: string) => void;
  onAction: (action: CalendarActionModel, source?: Record<string, unknown>) => void;
}) {
  // The view picker is the descriptor DATA — Day/Week/Month/Agenda and any
  // user-added view (3-day, Work week, …) appear here with zero code change.
  const viewItems = React.useMemo(
    () => model.viewDescriptors.map((view) => ({ id: view.view_id, label: view.label })),
    [model.viewDescriptors],
  );
  const actionFor = React.useCallback((...needles: string[]): CalendarActionModel | undefined => {
    const normalizedNeedles = needles.map((needle) => needle.toLowerCase());
    return model.actions.find((action) => {
      const haystack = `${action.id} ${action.label ?? ''}`.toLowerCase();
      return normalizedNeedles.some((needle) => haystack.includes(needle));
    });
  }, [model.actions]);
  const previousAction = actionFor('previous', 'prev');
  const todayAction = actionFor('today');
  const nextAction = actionFor('next');
  const searchAction = actionFor('search');
  const bookingAction = actionFor('booking');
  const newEventAction = actionFor('new event', 'new-event', 'create event', 'create-event');
  const reasonFor = React.useCallback(
    (action: CalendarActionModel | undefined) => calendarControlDisabledReason(action, model),
    [model],
  );
  const previousReason = reasonFor(previousAction);
  const todayReason = reasonFor(todayAction);
  const nextReason = reasonFor(nextAction);
  const searchReason = reasonFor(searchAction);
  const bookingReason = reasonFor(bookingAction);
  const newEventReason = reasonFor(newEventAction);

  return (
    <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md" width="full" minWidth="0">
      <Container layout="horizontal" alignItems="center" gap="sm" minWidth="0">
        <Button type="button" variant="ghost" size="sm" aria-label="Previous date" disabled={Boolean(previousReason)} title={previousReason || undefined} onClick={() => previousAction && onAction(previousAction, { rangeStart: model.rangeStart, rangeEnd: model.rangeEnd })}>Prev</Button>
        <Button type="button" variant="secondary" size="sm" disabled={Boolean(todayReason)} title={todayReason || undefined} onClick={() => todayAction && onAction(todayAction, { rangeStart: model.rangeStart, rangeEnd: model.rangeEnd })}>Today</Button>
        <Button type="button" variant="ghost" size="sm" aria-label="Next date" disabled={Boolean(nextReason)} title={nextReason || undefined} onClick={() => nextAction && onAction(nextAction, { rangeStart: model.rangeStart, rangeEnd: model.rangeEnd })}>Next</Button>
        <Container layout="vertical" gap="none" minWidth="0">
          <Text variant="heading-lg" truncate>{model.dateLabel}</Text>
          <Text variant="caption" color="muted">{model.timezone}</Text>
        </Container>
      </Container>

      <Container layout="horizontal" alignItems="center" justifyContent="end" gap="sm" wrap="wrap">
        <SegmentedControl
          ariaLabel="Calendar view"
          items={viewItems}
          value={model.viewId}
          onValueChange={(value) => onViewChange(value)}
        />
        <Button type="button" variant="outline" size="sm" disabled={Boolean(searchReason)} title={searchReason || undefined} onClick={() => searchAction && onAction(searchAction)}>Search</Button>
        <Button type="button" variant="secondary" size="sm" disabled={Boolean(bookingReason)} title={bookingReason || undefined} onClick={() => bookingAction && onAction(bookingAction, { rangeStart: model.rangeStart, rangeEnd: model.rangeEnd })}>Create booking link</Button>
        <Button type="button" variant="primary" size="sm" disabled={Boolean(newEventReason)} title={newEventReason || undefined} onClick={() => newEventAction && onAction(newEventAction, { rangeStart: model.rangeStart, rangeEnd: model.rangeEnd })} data-reach-action="create-event">New event</Button>
      </Container>
    </Container>
  );
}
