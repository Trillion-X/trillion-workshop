import React from 'react';
import { Badge, Card, Container, Text } from '@/packages/ui';
import { statusView } from '@/packages/ui/show/status-vocabulary/StatusVocabulary';
import type { InstructionBlock } from '../read-data/read-ai-instruction-blocks';

export type InstructionBlockListProps = {
  items: readonly InstructionBlock[];
  title?: string;
};

export function InstructionBlockList({ items, title = 'Instruction blocks' }: InstructionBlockListProps) {
  return (
    <Card
      as="section"
      variant="surface"
      padding="lg"
      layout="stack"
      minWidth="0"
      data-package="ai-instruction-blocks"
      data-surface="ai-instruction-block-list"
    >
      <Container as="header" layout="vertical" gap="xs">
        <Text variant="overline">Working method</Text>
        <Text variant="heading-lg">{title}</Text>
        <Text variant="body" color="subtle" leading="relaxed">
          These are the active instructions shaping how Trillion reasons, writes, and completes work.
        </Text>
      </Container>

      {items.length === 0 ? (
        <Card variant="nested" padding="md" layout="stack" data-status="empty">
          <Text variant="heading-xs">No active instructions are visible</Text>
          <Text variant="body-xs" color="subtle">
            The workspace will show each instruction here after its owner publishes it.
          </Text>
        </Card>
      ) : null}

      <Container as="ol" layout="vertical" gap="sm" aria-label="Active instruction blocks">
        {items.map((item, index) => (
          <Card as="li" key={item.id} variant="nested" padding="md" layout="stack">
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
              <Container layout="horizontal" gap="sm" alignItems="center">
                <Badge variant="neutral">{index + 1}</Badge>
                <Text variant="body" weight="semibold">{item.label ?? item.id}</Text>
              </Container>
              {item.status ? (() => {
                const view = statusView(item.status, { available: { label: 'Active', tone: 'success' } });
                return <Badge variant={view.tone}>{view.label}</Badge>;
              })() : null}
            </Container>
            {item.description ? <Text variant="body-xs" color="subtle">{item.description}</Text> : null}
            {item.body ? (
              <Card variant="panel" padding="md">
                <Text as="div" variant="body-xs" wrap="preserve" leading="relaxed">{item.body}</Text>
              </Card>
            ) : null}
            <details>
              <summary>Technical proof</summary>
              <Text as="div" variant="caption" color="faint" mono wrap="preserve">
                {`Instruction record: ${item.id}${item.revision_ref ? `\nRevision: ${item.revision_ref}` : ''}`}
              </Text>
            </details>
          </Card>
        ))}
      </Container>
    </Card>
  );
}
