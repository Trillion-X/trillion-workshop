// StatementHeader — kicker + statement + optional subtitle. Container + Text only.

import React from 'react';
import { Container } from '../container';
import { Text } from '../text';

export interface StatementHeaderProps {
  kicker?: string;
  statement: string;
  subtitle?: string;
}

export function StatementHeader({ kicker, statement, subtitle }: StatementHeaderProps) {
  return (
    <Container layout="vertical" gap="xs" padding="none">
      {kicker ? (
        <Text variant="label" color="accent">
          {kicker}
        </Text>
      ) : null}
      <Text variant="heading-xl" leading="tight">
        {statement}
      </Text>
      {subtitle ? (
        <Text variant="body" color="muted">
          {subtitle}
        </Text>
      ) : null}
    </Container>
  );
}
