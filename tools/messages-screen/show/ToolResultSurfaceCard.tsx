// PORTED FROM: bitfield-packages/packages/chat/show/ToolResultSurfaceCard.tsx @ e99ac5976
import React from 'react';
import { ArrowUpRight, Database } from 'lucide-react';
import { Button, Card, Container, Icon, Text } from '../../ui';
import type { ToolResultSurfaceSummary } from '../read-data/read-tool-result-surface-card';

export function ToolResultSurfaceCard({
  toolLabel,
  surfaceTitle,
  summary,
  onOpen,
  openError,
}: {
  toolLabel: string;
  surfaceTitle: string;
  summary: ToolResultSurfaceSummary;
  onOpen: () => void;
  openError?: string | null;
}) {
  return (
    <Card
      variant="nested"
      padding="md"
      data-tool-result-surface-card={summary.surfaceRef}
    >
      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Icon icon={Database} size="sm" color="accent" />
          <Container layout="vertical" gap="none" flex={1} minWidth="0">
            <Text variant="label" color="subtle" truncate>
              {toolLabel}
            </Text>
            <Text variant="body-xs" color="faint" truncate>
              {surfaceTitle}
            </Text>
          </Container>
          <Button variant="secondary" size="sm" onClick={onOpen}>
            Open {surfaceTitle}
            <Icon icon={ArrowUpRight} size="xs" />
          </Button>
        </Container>

        {summary.counts.length > 0 || summary.rowCount !== null ? (
          <Container layout="horizontal" gap="lg" alignItems="center" wrap="wrap">
            {summary.counts.map((count) => (
              <Container key={count.key} layout="vertical" gap="none">
                <Text variant="heading" color="default">
                  {count.value.toLocaleString()}
                </Text>
                <Text variant="caption" color="faint">
                  {count.label}
                </Text>
              </Container>
            ))}
            {summary.rowCount !== null ? (
              <Container layout="vertical" gap="none">
                <Text variant="heading" color="default">
                  {summary.rowCount.toLocaleString()}
                </Text>
                <Text variant="caption" color="faint">
                  {summary.rowCount === 1 ? 'Record' : 'Records'}
                </Text>
              </Container>
            ) : null}
          </Container>
        ) : null}

        {openError ? <Text variant="body-xs" color="error">{openError}</Text> : null}
      </Container>
    </Card>
  );
}
