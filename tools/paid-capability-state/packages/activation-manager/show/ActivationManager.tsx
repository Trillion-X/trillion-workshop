import React from 'react';
import { Badge, Button, Card, Container, Text } from '../../../../ui';
import type { ActivationProjection } from '../read-data/read-activations';

export interface ActivationManagerProps {
  activations: ActivationProjection[];
  onRunAction?: (action: ActivationProjection['nextActionDescriptors'][number]) => void;
}

export function ActivationManager({
  activations,
  onRunAction,
}: ActivationManagerProps) {
  return (
    <Container as="section">
      <Container gap="xs">
        <Text as="h2" variant="heading-2xl">Activations</Text>
        <Text muted>
          Active devices can use this account.
        </Text>
      </Container>
      <Container gap="sm">
        {activations.map((activation) => (
          <Card as="article" key={activation.id}>
            <Container gap="xs">
              <Text as="strong">{activation.title}</Text>
              <Badge tone={activation.state.tone ?? 'neutral'}>
                {activation.state.label ?? activation.state.key}
              </Badge>
            </Container>
            {activation.nextActionDescriptors.map((action) => (
              <Button
                disabled={!action.enabled}
                key={action.id}
                onClick={() => onRunAction?.(action)}
                tone="accent"
                type="button"
              >
                {action.label}
              </Button>
            ))}
          </Card>
        ))}
      </Container>
    </Container>
  );
}
