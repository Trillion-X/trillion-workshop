import React from 'react';
import { Badge } from '../../../../ui/show/badge';
import { Button } from '../../../../ui/show/button';
import { Container } from '../../../../ui/show/container';
import { Text } from '../../../../ui/show/text';
import type { CalendarActionModel, CalendarScreenModel } from './calendar-screen-model';
import { calendarControlDisabledReason, labelForBlockState } from './calendar-screen-model';
import { timeRange } from './calendar-view-dates';

function findAction(model: CalendarScreenModel, ...needles: string[]): CalendarActionModel | undefined {
  const normalizedNeedles = needles.map((needle) => needle.toLowerCase());
  return model.actions.find((action) => {
    const haystack = `${action.id} ${action.label}`.toLowerCase();
    return normalizedNeedles.some((needle) => haystack.includes(needle));
  });
}

export function CalendarAgenda({
  model,
  onAction,
  onSelectBlock,
}: {
  model: CalendarScreenModel;
  onAction: (action: CalendarActionModel, source?: Record<string, unknown>) => void;
  onSelectBlock?: (blockId: string) => void;
}) {
  const newEventAction = findAction(model, 'new-event', 'new event', 'create');
  const newEventReason = calendarControlDisabledReason(newEventAction, model);
  return (
    <Container layout="vertical" gap="md" minHeight="0" overflow="auto" background="primary" data-calendar-agenda="true">
      <Container layout="horizontal" gap="xs" overflow="x-auto" padding="sm" position="sticky" zIndex="10" background="primary">
        {model.accounts.map((account) => (
          <Badge key={account.id} variant={account.status === 'connected' ? 'success' : 'warning'}>{account.label}</Badge>
        ))}
      </Container>

      <Container layout="vertical" gap="sm" padding="md">
        {model.blocks.length === 0 ? (
          <Container layout="vertical" gap="sm" padding="lg" border="all" rounded="md" background="secondary">
            <Text variant="heading-xs">No events today.</Text>
            <Text variant="body-xs" color="muted">Use New event to add time here.</Text>
          </Container>
        ) : model.blocks.map((block) => (
          <Container
            key={block.id}
            as="button"
            type="button"
            data-calendar-agenda-block={block.id}
            aria-pressed={block.id === model.selectedBlockId}
            layout="vertical"
            gap="xs"
            padding="md"
            border="all"
            rounded="md"
            background="secondary"
            data-calendar-agenda-selected={block.id === model.selectedBlockId ? 'true' : undefined}
            onClick={() => onSelectBlock?.(block.id)}
          >
            <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm">
              <Text variant="body-xs" weight="semibold" truncate>{block.display.title}</Text>
              <Badge variant={block.state.ref === 'conflict' ? 'error' : block.state.ref === 'waiting-to-sync' ? 'warning' : 'neutral'}>
                {labelForBlockState(block.state.ref)}
              </Badge>
            </Container>
            <Text variant="caption" color="muted">{timeRange(block.interval.start, block.interval.end)}</Text>
          </Container>
        ))}
      </Container>

      <Container position="sticky" padding="md" background="primary" inset="bottom-0">
        <Button
          type="button"
          variant="primary"
          size="lg"
          fullWidth
          disabled={Boolean(newEventReason)}
          title={newEventReason || undefined}
          onClick={() => newEventAction && onAction(newEventAction, { rangeStart: model.rangeStart, rangeEnd: model.rangeEnd })}
        >
          New event
        </Button>
        {newEventReason ? (
          <Text variant="caption" color="muted" align="center">{newEventReason}</Text>
        ) : null}
      </Container>
    </Container>
  );
}
