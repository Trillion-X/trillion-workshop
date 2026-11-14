import React from 'react';
import type { LucideProps } from 'lucide-react';
import { Badge, type BadgeProps } from '../badge';
import { Card } from '../card';
import { Container } from '../container';
import { Icon } from '../icon';
import { Text } from '../text';

export type WorkStartItem = {
  label: React.ReactNode;
  detail?: React.ReactNode;
  badge?: React.ReactNode;
  tone?: BadgeProps['variant'];
};

export type WorkStartStateProps = {
  icon: React.ElementType<LucideProps>;
  title: React.ReactNode;
  description?: React.ReactNode;
  items?: readonly WorkStartItem[];
  action?: React.ReactNode;
  children?: React.ReactNode;
};

export function WorkSkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <Container layout="vertical" gap="xs" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <Card key={index} variant="nested" padding="sm" className="animate-pulse">
          <Container layout="vertical" gap="xs">
            <div className="h-2 w-2/3 rounded bg-[var(--glass-bg-hover)]" />
            <div className="h-2 w-1/3 rounded bg-[var(--glass-bg-subtle)]" />
          </Container>
        </Card>
      ))}
    </Container>
  );
}

export function WorkStartState({
  icon,
  title,
  description,
  items = [],
  action,
  children,
}: WorkStartStateProps) {
  return (
    <Card variant="nested" padding="md" layout="stack">
      <Container layout="horizontal" gap="sm" alignItems="start">
        <Icon icon={icon} size="lg" color="faint" />
        <Container layout="vertical" gap="xs" flex={1} minHeight="0">
          <Text variant="heading-lg" leading="tight">{title}</Text>
          {description ? (
            <Text variant="body-xs" color="faint" leading="relaxed">{description}</Text>
          ) : null}
        </Container>
      </Container>
      {items.length > 0 ? (
        <Container layout="grid" gridCols="auto-fill-xs" gap="sm">
          {items.map((item, index) => (
            <Card key={index} variant="ghost" padding="sm">
              <Container layout="horizontal" gap="sm" alignItems="start" justifyContent="between">
                <Container layout="vertical" gap="xs" flex={1} minHeight="0">
                  <Text variant="body-xs" weight="semibold" color="strong">{item.label}</Text>
                  {item.detail ? (
                    <Text variant="caption" color="faint" leading="relaxed">{item.detail}</Text>
                  ) : null}
                </Container>
                {item.badge ? (
                  <Badge variant={item.tone ?? 'neutral'} size="sm">{item.badge}</Badge>
                ) : null}
              </Container>
            </Card>
          ))}
        </Container>
      ) : null}
      {children}
      {action ? (
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" wrap>
          {action}
        </Container>
      ) : null}
    </Card>
  );
}
