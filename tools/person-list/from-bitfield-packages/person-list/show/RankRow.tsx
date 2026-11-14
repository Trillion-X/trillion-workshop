// RankRow — one leaderboard row: rank, avatar, title, value. ui primitives only.

import React from 'react';
import { Card, Container, DisplayMark, Text } from '@/packages/ui';

export interface RankRowProps {
  rank: number;
  title: string;
  avatarName: string;
  value: string;
  highlighted?: boolean;
}

export function RankRow({ rank, title, avatarName, value, highlighted }: RankRowProps) {
  return (
    <Card variant={highlighted ? 'surface' : 'ghost'} padding="sm">
      <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
        <Text variant="label" color={highlighted ? 'accent' : 'muted'} tabular>
          {rank}
        </Text>
        <DisplayMark name={avatarName} size="sm" />
        <Container gap="none" padding="none" flex={1}>
          <Text variant="body-xs" color={highlighted ? 'strong' : 'default'} leading="tight">
            {title}
          </Text>
        </Container>
        <Text variant="body-xs" color="accent" tabular>
          {value}
        </Text>
      </Container>
    </Card>
  );
}
