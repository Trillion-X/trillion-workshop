import React from 'react';
import { Badge, Card, Container, Text } from '@/packages/ui';
import type { ActionGuardData } from '../read-data/read-ai-action-guards';

function humanizeReference(value: string): string {
  const segment = value.split(/[.:/]/).filter(Boolean).at(-1) ?? value;
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Current action';
}

export type ActionGuardPanelProps = {
  data: ActionGuardData;
  title?: string;
};

export function ActionGuardPanel({ data, title = 'Action guards' }: ActionGuardPanelProps) {
  const hasPolicy = data.limits.length > 0 || data.states.length > 0;
  return (
    <Card
      as="section"
      variant="surface"
      padding="lg"
      layout="stack"
      minWidth="0"
      data-package="ai-action-guard"
      data-surface="ai-action-guard-panel"
    >
      <Container as="header" layout="vertical" gap="xs">
        <Text variant="overline">Autonomy and safety</Text>
        <Text variant="heading-lg">{title}</Text>
        <Text variant="body" color="subtle" leading="relaxed">
          See what Trillion may do on its own and where it must pause before anything changes.
        </Text>
      </Container>

      {!hasPolicy ? (
        <Card variant="nested" padding="md" layout="stack" data-status="empty">
          <Text variant="heading-xs">No action boundaries are available yet</Text>
          <Text variant="body-xs" color="subtle">
            Trillion will keep actions paused until the current guard policy is confirmed.
          </Text>
        </Card>
      ) : null}

      {data.states.length > 0 ? (
        <Container as="section" layout="vertical" gap="sm" aria-labelledby="guard-states-heading">
          <Text id="guard-states-heading" variant="heading-xs">Current decisions</Text>
          {data.states.map((state) => {
            const allowed = state.allowed === true;
            return (
              <Card key={state.id} variant="nested" padding="md" layout="stack">
                <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                  <Text variant="body" weight="semibold">
                    {humanizeReference(state.subject_ref ?? state.id)}
                  </Text>
                  <Badge variant={allowed ? 'success' : 'warning'}>
                    {allowed ? 'Available' : 'Pauses first'}
                  </Badge>
                </Container>
                <Text variant="body-xs" color="subtle">
                  {allowed
                    ? 'This action is inside the current confirmed boundary.'
                    : 'Trillion will pause before this action changes anything.'}
                </Text>
                <details>
                  <summary>Technical proof</summary>
                  <Text as="div" variant="caption" color="faint" mono wrap="preserve">
                    {`Policy record: ${state.id}${state.state ? `\nOwner state: ${state.state}` : ''}${typeof state.failure_count === 'number' ? `\nRecorded failures: ${state.failure_count}` : ''}`}
                  </Text>
                </details>
              </Card>
            );
          })}
        </Container>
      ) : null}

      {data.limits.length > 0 ? (
        <Container as="section" layout="vertical" gap="sm" aria-labelledby="guard-limits-heading">
          <Text id="guard-limits-heading" variant="heading-xs">Usage boundaries</Text>
          {data.limits.map((limit) => (
            <Card key={limit.id} variant="nested" padding="md" layout="row">
              <Container layout="vertical" gap="xs" flex="1">
                <Text variant="body" weight="semibold">{humanizeReference(limit.action_ref ?? limit.id)}</Text>
                <Text variant="body-xs" color="subtle">
                  {typeof limit.limit === 'number'
                    ? `${limit.limit} allowed ${limit.period_ref ?? 'within the current period'}`
                    : 'No numeric limit is published.'}
                  {limit.remaining == null ? '' : ` ${limit.remaining} remaining.`}
                </Text>
              </Container>
              <Badge variant={limit.exhausted ? 'warning' : 'neutral'}>{limit.exhausted ? 'Limit reached' : 'Bounded'}</Badge>
              <details>
                <summary>Technical proof</summary>
                <Text as="div" variant="caption" color="faint" mono wrap="preserve">
                  {`Boundary record: ${limit.id}${limit.action_ref ? `\nAction: ${limit.action_ref}` : ''}`}
                </Text>
              </details>
            </Card>
          ))}
        </Container>
      ) : null}
      {(data.decisions ?? []).length > 0 ? (
        <Container as="section" layout="vertical" gap="sm" aria-labelledby="guard-history-heading">
          <Text id="guard-history-heading" variant="heading-xs">Past decisions</Text>
          <Text variant="body-xs" color="subtle">Past decisions do not grant permission for a new action.</Text>
          {data.decisions.map((decision) => (
            <Card key={decision.id} variant="nested" padding="md" layout="stack">
              <Text variant="body" weight="semibold">{humanizeReference(decision.action_ref ?? decision.id)}</Text>
              <Text variant="body-xs" color="subtle">{decision.decision ? humanizeReference(decision.decision) : 'No decision recorded'}</Text>
            </Card>
          ))}
        </Container>
      ) : null}
    </Card>
  );
}
