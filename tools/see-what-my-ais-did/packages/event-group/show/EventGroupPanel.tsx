// package-set://bitfield-studio/packages/event-group/show/EventGroupPanel.tsx

import React from 'react';
import { Badge, Card, Container, Icon, ScrollableSurface, Text } from '@/packages/ui';
import { Clock3, Layers3, ListChecks } from 'lucide-react';
import { eventGroupSurface } from '@/packages/event-group/read-data/event-group-surface';

export function EventGroupPanel() {
  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg">
        <Container layout="horizontal" justifyContent="between" alignItems="start">
          <Container layout="vertical" gap="xs">
            <Badge variant="info" size="sm">{eventGroupSurface.status}</Badge>
            <Text variant="heading-xl">{eventGroupSurface.title}</Text>
            <Text variant="body-xs" color="muted" leading="relaxed">{eventGroupSurface.summary}</Text>
          </Container>
          <Icon icon={Layers3} size="lg" color="accent" />
        </Container>

        <Card variant="nested" padding="md">
          <Container layout="vertical" gap="sm">
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Icon icon={Clock3} size="sm" color="info" />
              <Text variant="heading-xs">{eventGroupSurface.emptyMessage}</Text>
            </Container>
            <Text variant="body-xs" color="muted" leading="relaxed">
              Activity groups appear after connected services or automated work publish related updates.
            </Text>
          </Container>
        </Card>

        <Container layout="grid" gridCols={3} gap="md">
          {eventGroupSurface.groupingReasons.map(([label, detail]) => (
            <Card key={label} variant="nested" padding="md">
              <Container layout="vertical" gap="sm">
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Icon icon={ListChecks} size="sm" color="success" />
                  <Text variant="heading-xs">{label}</Text>
                </Container>
                <Text variant="body-xs" color="muted">{detail}</Text>
              </Container>
            </Card>
          ))}
        </Container>

        <Card variant="nested" padding="md">
          <Container layout="vertical" gap="sm">
            <Text variant="heading-xs">What can be grouped</Text>
            <Container layout="horizontal" gap="sm" wrap>
              {eventGroupSurface.examples.map((example) => (
                <Badge key={example} variant="muted-outline" size="sm">{example}</Badge>
              ))}
            </Container>
          </Container>
        </Card>
      </Container>
    </ScrollableSurface>
  );
}
