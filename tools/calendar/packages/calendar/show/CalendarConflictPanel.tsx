import React from 'react';
import { Button } from '../../../../ui/show/button';
import { Container } from '../../../../ui/show/container';
import { Text } from '../../../../ui/show/text';
import type { CalendarScreenModel } from './calendar-screen-model';

export function CalendarConflictPanel({ model }: { model: CalendarScreenModel }) {
  if (model.conflictBlocks.length === 0 && model.issues.every((issue) => issue.label !== 'Resolve conflict')) {
    return null;
  }

  return (
    <Container layout="vertical" gap="sm" padding="md" border="all" rounded="md" background="secondary">
      <Text variant="heading-xs" color="error">Resolve conflict</Text>
      {model.conflictBlocks.map((block) => (
        <Container key={block.id} layout="vertical" gap="xs" padding="sm" rounded="md" background="tertiary">
          <Text variant="body-xs" weight="semibold">{block.display.title}</Text>
          <Text variant="caption" color="muted">
            Original time and proposed time are both kept visible until you choose.
          </Text>
          <Container layout="horizontal" gap="sm" wrap="wrap">
            <Button type="button" variant="secondary" size="sm">Keep local copy</Button>
            <Button type="button" variant="primary" size="sm">Resolve conflict</Button>
          </Container>
        </Container>
      ))}
    </Container>
  );
}
