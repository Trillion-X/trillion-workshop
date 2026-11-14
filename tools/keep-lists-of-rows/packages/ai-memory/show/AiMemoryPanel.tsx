import React from 'react';
import { Badge, Card, Container, Text } from '@/packages/ui';
import type { MemoryContextItem } from '../read-data/read-memory-context';

function humanizeReference(value: string): string {
  const segment = value.split(/[.:/]/).filter(Boolean).at(-1) ?? value;
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Current workspace';
}

function importancePercent(score: number): number {
  const normalized = score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

export type AiMemoryPanelProps = {
  items: readonly MemoryContextItem[];
  title?: string;
};

export function AiMemoryPanel({ items, title = 'Memory context' }: AiMemoryPanelProps) {
  return (
    <Card
      as="section"
      variant="surface"
      padding="lg"
      layout="stack"
      minWidth="0"
      data-package="ai-memory"
      data-surface="ai-memory-panel"
    >
      <Container as="header" layout="vertical" gap="xs">
        <Text variant="overline">Context</Text>
        <Text variant="heading-lg">{title}</Text>
        <Text variant="body" color="subtle" leading="relaxed">
          Review the confirmed context Trillion can use now. Memory type and scope stay visible before the underlying record.
        </Text>
      </Container>

      {items.length === 0 ? (
        <Card variant="nested" padding="md" layout="stack" data-status="empty">
          <Text variant="heading-xs">Nothing is stored for this view yet</Text>
          <Text variant="body-xs" color="subtle">
            Trillion will show memory here only after the memory owner confirms it.
          </Text>
        </Card>
      ) : null}

      <Container as="ul" layout="vertical" gap="sm" aria-label="Confirmed memory records">
        {items.map((item) => (
          <Card as="li" key={item.id} variant="nested" padding="md" layout="stack">
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
              <Text variant="body" weight="semibold">{item.label ?? 'Saved context'}</Text>
              {item.memory_type ? <Badge variant="info">{humanizeReference(item.memory_type)}</Badge> : null}
            </Container>
            <Text variant="body-xs" leading="relaxed" wrap="preserve">{item.body}</Text>
            <Container layout="horizontal" gap="sm" wrap="wrap" alignItems="center">
              {item.subject_ref ? <Badge variant="muted-outline">Scope: {humanizeReference(item.subject_ref)}</Badge> : null}
              {typeof item.importance_score === 'number'
                ? <Badge variant="neutral">Priority {importancePercent(item.importance_score)}%</Badge>
                : null}
            </Container>
            <details>
              <summary>Technical proof</summary>
              <Text as="div" variant="caption" color="faint" mono wrap="preserve">
                {`Memory record: ${item.id}${item.agent_ref ? `\nAgent: ${item.agent_ref}` : ''}${item.expires_at ? `\nExpires: ${item.expires_at}` : ''}`}
              </Text>
            </details>
          </Card>
        ))}
      </Container>
    </Card>
  );
}
