// package-set://bitfield-studio/packages/trade-audit/show/TradeAuditPanel.tsx

import React from 'react';
import { Badge, Card, Container, Icon, ScrollableSurface, Text } from '@/packages/ui';
import { Link2, ScrollText, ShieldAlert } from 'lucide-react';
import { tradeAuditSurface } from '@/packages/trade-audit/read-data/trade-audit-surface';

export function TradeAuditPanel() {
  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="xl">
        <Card variant="surface" padding="lg" className="rounded-3xl">
          <Container layout="horizontal" gap="xl" alignItems="stretch" justifyContent="between" wrap>
            <Container layout="vertical" gap="lg" className="min-w-[280px] flex-1">
              <Container layout="horizontal" gap="sm" alignItems="center" wrap>
                <Badge variant="muted-outline" size="lg">{tradeAuditSurface.status}</Badge>
                <Badge variant="muted-outline" size="lg">orders</Badge>
              </Container>
              <Container layout="vertical" gap="xs">
                <Text variant="display" leading="tight">{tradeAuditSurface.title}</Text>
                <Text variant="heading-lg" color="muted" leading="snug">{tradeAuditSurface.summary}</Text>
              </Container>
            </Container>
            <Card variant="nested" padding="lg" className="min-w-[260px] flex-1 rounded-2xl">
              <Container layout="vertical" gap="lg">
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Icon icon={ScrollText} size="sm" color="muted" />
                  <Text variant="heading-lg">Latest order</Text>
                </Container>
                <Text variant="display" leading="tight">None</Text>
                <Text variant="body" color="muted">Run a paper order to save the first order.</Text>
              </Container>
            </Card>
          </Container>
        </Card>

        <Card variant="surface" padding="lg" className="rounded-3xl">
          <Container layout="vertical" gap="lg">
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Icon icon={Link2} size="sm" color="info" />
              <Text variant="heading-xl">Saved steps</Text>
            </Container>
            <Container layout="horizontal" gap="sm" wrap>
              {tradeAuditSurface.eventKinds.map((kind) => (
                <Badge key={kind} variant="muted-outline" size="lg">{kind}</Badge>
              ))}
            </Container>
          </Container>
        </Card>

        <Card variant="surface" padding="lg" className="rounded-3xl">
          <Container layout="vertical" gap="lg">
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Icon icon={Link2} size="sm" color="success" />
              <Text variant="heading-xl">How it fills</Text>
            </Container>
            <Container layout="vertical" gap="none">
              {tradeAuditSurface.operationGraph.map(([name, role]) => (
                <Container key={name} layout="horizontal" gap="md" alignItems="center" justifyContent="between" className="border-b border-[var(--border-primary)] py-4 last:border-b-0">
                  <Text variant="heading-lg">{name}</Text>
                  <Text variant="body" color="muted" align="right">{role}</Text>
                </Container>
              ))}
            </Container>
          </Container>
        </Card>

        <Card variant="nested" padding="lg" className="rounded-2xl">
          <Container layout="vertical" gap="md">
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Icon icon={ShieldAlert} size="sm" color="success" />
              <Text variant="heading-lg">Rules</Text>
            </Container>
            {tradeAuditSurface.invariants.map((line) => (
              <Text key={line} variant="body" color="muted">{line}</Text>
            ))}
          </Container>
        </Card>
      </Container>
    </ScrollableSurface>
  );
}
