// package-set://bitfield-studio/packages/connector-room/show/ConnectorRoomPanel.tsx

import React from 'react';
import { Badge, Card, Container, Icon, ScrollableSurface, Text } from '@/packages/ui';
import { DoorOpen, ListChecks, UsersRound } from 'lucide-react';
import { connectorRoomSurface } from '@/packages/connector-room/read-data/connector-room-surface';

export function ConnectorRoomPanel() {
  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg">
        <Container layout="horizontal" justifyContent="between" alignItems="start">
          <Container layout="vertical" gap="xs">
            <Badge variant="warning" size="sm">{connectorRoomSurface.status}</Badge>
            <Text variant="heading-xl">{connectorRoomSurface.title}</Text>
            <Text variant="body-xs" color="muted" leading="relaxed">{connectorRoomSurface.summary}</Text>
          </Container>
          <Icon icon={DoorOpen} size="lg" color="accent" />
        </Container>

        <Container layout="grid" gridCols={4} gap="sm">
          {connectorRoomSurface.zones.map(([label, detail]) => (
            <Card key={label} variant="nested" padding="sm">
              <Text variant="heading-xs">{label}</Text>
              <Text variant="caption" color="muted">{detail}</Text>
            </Card>
          ))}
        </Container>

        <Card variant="nested" padding="md">
          <Container layout="vertical" gap="sm">
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Icon icon={UsersRound} size="sm" color="info" />
              <Text variant="heading-xs">{connectorRoomSurface.emptyMessage}</Text>
            </Container>
            <Text variant="body-xs" color="muted" leading="relaxed">
              Connected workflows appear here when a service-backed workflow has shared services, permissions, or activity to review.
            </Text>
          </Container>
        </Card>

        <Card variant="nested" padding="md">
          <Container layout="vertical" gap="sm">
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Icon icon={ListChecks} size="sm" color="success" />
              <Text variant="heading-xs">Open one from</Text>
            </Container>
            <Container layout="horizontal" gap="sm" wrap>
              {connectorRoomSurface.nextSteps.map((step) => (
                <Badge key={step} variant="muted-outline" size="sm">{step}</Badge>
              ))}
            </Container>
          </Container>
        </Card>
      </Container>
    </ScrollableSurface>
  );
}
