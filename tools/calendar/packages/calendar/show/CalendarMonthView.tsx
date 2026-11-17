import React from 'react';
import { ColorDot } from '../../../../ui/show/color-dot';
import { Container } from '../../../../ui/show/container';
import { Text } from '../../../../ui/show/text';
import type { CalendarScreenModel } from './calendar-screen-model';
import type { CalendarViewDescriptor } from '../read-data/read-calendar-view-descriptors';
import { blocksForDay, monthViewDays, monthViewLabel } from './calendar-view-dates';

const DEFAULT_MAX_CHIPS = 3;

export function CalendarMonthView({
  model,
  descriptor,
  onSelectBlock,
}: {
  model: CalendarScreenModel;
  descriptor: CalendarViewDescriptor;
  onSelectBlock(blockId: string): void;
}) {
  const days = monthViewDays(model);
  const maxChips = Math.max(1, descriptor.max_chips_per_cell ?? DEFAULT_MAX_CHIPS);

  return (
    <Container layout="vertical" gap="sm" minHeight="0" overflow="hidden" rounded="lg" border="all" background="primary" minWidth="0" data-calendar-month-grid="true">
      <Container layout="horizontal" alignItems="center" justifyContent="between" padding="md" border="bottom">
        <Text variant="heading-xs">{monthViewLabel(model)}</Text>
        <Text variant="caption" color="muted">{model.blocks.length} events</Text>
      </Container>
      <Container layout="grid" gridColumns={7} gap="none" border="bottom">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
          <Container key={label} padding="sm" border="right">
            <Text variant="caption" color="muted">{label}</Text>
          </Container>
        ))}
      </Container>
      <Container layout="grid" gridColumns={7} gap="none" minHeight="0" overflow="auto" flex="1">
        {days.map((day) => {
          const dayBlocks = blocksForDay(model.blocks, day.key);
          return (
            <Container key={day.key} layout="vertical" gap="xs" padding="sm" border="right" minHeight="7rem" background={day.inMonth ? 'primary' : 'tertiary'}>
              <Text variant="caption" color={day.inMonth ? 'primary' : 'muted'}>{day.shortLabel}</Text>
              {dayBlocks.slice(0, maxChips).map((block) => (
                <Container
                  key={block.id}
                  as="button"
                  type="button"
                  data-calendar-month-block={block.id}
                  aria-pressed={block.id === model.selectedBlockId}
                  data-calendar-month-selected={block.id === model.selectedBlockId ? 'true' : undefined}
                  layout="horizontal"
                  alignItems="center"
                  gap="xs"
                  padding="xs"
                  rounded="md"
                  background="secondary"
                  minWidth="0"
                  onClick={() => onSelectBlock(block.id)}
                >
                  <ColorDot color={block.display.color || 'var(--accent-purple)'} size="sm" />
                  <Text variant="caption" weight="semibold" truncate>{block.display.title}</Text>
                </Container>
              ))}
              {dayBlocks.length > maxChips ? (
                <Text variant="caption" color="muted">{dayBlocks.length - maxChips} more</Text>
              ) : null}
            </Container>
          );
        })}
      </Container>
    </Container>
  );
}
