import * as React from 'react';

import { Badge } from '../../../ui/show/badge';
import { Card } from '../../../ui/show/card';
import { Container } from '../../../ui/show/container';
import { Text } from '../../../ui/show/text';

export type MediaNextActionProps = {
  title: string;
  detail: string;
  ready: boolean;
  primaryAction: React.ReactNode;
  secondaryAction?: React.ReactNode;
};

export function MediaNextAction({
  title,
  detail,
  ready,
  primaryAction,
  secondaryAction,
}: MediaNextActionProps) {
  return (
    <Card variant="nested" padding="md" className="rounded-2xl">
      <Container layout="vertical" gap="md">
        <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm">
          <Text variant="heading">{title}</Text>
          <Badge variant={ready ? 'success' : 'neutral'} size="sm">
            {ready ? 'Ready' : 'Needs media'}
          </Badge>
        </Container>
        <Text variant="body" color="faint">{detail}</Text>
        <Container layout="horizontal" gap="sm" wrap>
          {secondaryAction}
          {primaryAction}
        </Container>
      </Container>
    </Card>
  );
}
