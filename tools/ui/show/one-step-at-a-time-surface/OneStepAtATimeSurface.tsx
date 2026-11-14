import * as React from 'react';

import { Badge, type BadgeProps } from '../badge';
import { Card } from '../card';
import { Container } from '../container';
import { ScrollableSurface } from '../scrollable-surface';
import { Text } from '../text';

type Tone = NonNullable<BadgeProps['variant']>;

export type OneStepAtATimeItem = {
  key?: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  badge?: React.ReactNode;
  tone?: Tone;
};

export type OneStepAtATimeSurfaceProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  status?: React.ReactNode;
  statusTone?: Tone;
  /**
   * Visual density of the surface chrome.
   * - 'default': the original display-type hero (huge primary value, flat
   *   token backdrop). Existing surfaces keep this without changes.
   * - 'compact': calm reference-grade chrome — flat backdrop, modest title,
   *   the primary value/label as a quiet stat row instead of display type.
   */
  density?: 'default' | 'compact';
  primaryValue: React.ReactNode;
  primaryLabel: React.ReactNode;
  primaryDetail?: React.ReactNode;
  action?: React.ReactNode;
  nextStep?: React.ReactNode;
  itemsTitle?: React.ReactNode;
  items?: OneStepAtATimeItem[];
  emptyTitle?: React.ReactNode;
  emptyDetail?: React.ReactNode;
  detailsTitle?: React.ReactNode;
  details?: React.ReactNode;
  children?: React.ReactNode;
};

function WorkItem({ item }: { item: OneStepAtATimeItem }) {
  return (
    <Card variant="nested" padding="md">
      <Container layout="horizontal" gap="md" alignItems="start" justifyContent="between">
        <Container layout="vertical" gap="xs" flex={1} minHeight="0">
          <Text variant="body" weight="semibold" truncate>
            {item.title}
          </Text>
          {item.detail ? (
            <Text variant="body-xs" color="faint" leading="relaxed" wrap="preserve">
              {item.detail}
            </Text>
          ) : null}
        </Container>
        {item.badge ? (
          <Badge variant={item.tone ?? 'neutral'} size="sm">
            {item.badge}
          </Badge>
        ) : null}
      </Container>
    </Card>
  );
}

export function OneStepAtATimeSurface({
  title,
  description,
  status,
  statusTone = 'neutral',
  density = 'default',
  primaryValue,
  primaryLabel,
  primaryDetail,
  action,
  nextStep,
  itemsTitle,
  items = [],
  emptyTitle,
  emptyDetail,
  detailsTitle = 'Details',
  details,
  children,
}: OneStepAtATimeSurfaceProps) {
  const hasItemsBlock = items.length > 0 || Boolean(itemsTitle) || Boolean(emptyTitle) || Boolean(emptyDetail);
  const compact = density === 'compact';

  return (
    <ScrollableSurface>
      <Container
        layout="vertical"
        gap="lg"
        height="full"
        minHeight="0"
        className={compact
          ? 'bg-transparent px-6 py-5 sm:px-8 sm:py-6'
          : 'bg-[var(--bg-surface)] p-4 sm:p-6 lg:p-10'}
      >
        <Card
          variant="surface"
          padding={compact ? 'none' : 'lg'}
          layout="stack"
          className={compact
            ? 'w-full rounded-none border-0 bg-transparent shadow-none backdrop-blur-none'
            : 'mx-auto w-full max-w-4xl border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-primary)_88%,transparent)]'}
          style={compact ? {
            background: 'transparent',
            backdropFilter: 'none',
            boxShadow: 'none',
            border: 'none',
            borderRadius: 0,
          } : undefined}
        >
          {compact ? (
            // Reference law: the title carries the identity — no label chip,
            // and status appears only when something needs the person
            // (warnings/errors), never as ambient state confetti.
            status && statusTone === 'warning' ? (
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end">
                <Badge variant={statusTone} size="sm">{status}</Badge>
              </Container>
            ) : null
          ) : (
          status ? (
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="end" wrap>
              <Badge variant={statusTone} size="lg">
                {status}
              </Badge>
            </Container>
          ) : null
          )}

          <Container layout="vertical" gap={compact ? 'xs' : 'sm'}>
            <Text variant={compact ? 'heading-xl' : 'heading-2xl'} leading="tight">
              {title}
            </Text>
            {description ? (
              <Text variant="body" color="faint" leading="relaxed">
                {description}
              </Text>
            ) : null}
          </Container>

          {compact ? (
            <Container layout="horizontal" gap="sm" alignItems="baseline" wrap>
              <Text variant="heading-lg" tabular leading="tight">
                {primaryValue}
              </Text>
              <Text variant="body" color="faint">
                {primaryLabel}
              </Text>
              {primaryDetail ? (
                <Text variant="body-xs" color="faint" wrap="preserve">
                  {primaryDetail}
                </Text>
              ) : null}
            </Container>
          ) : (
          <Card variant="nested" padding="lg" className="border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]">
            <Container layout="vertical" gap="sm">
              <Text
                variant="display"
                tabular
                className="text-[clamp(2.75rem,9vw,6.5rem)] leading-none tracking-[-0.08em]"
              >
                {primaryValue}
              </Text>
              <Text variant="heading-lg" leading="tight">
                {primaryLabel}
              </Text>
              {primaryDetail ? (
                <Text variant="body-xs" color="faint" leading="relaxed" wrap="preserve">
                  {primaryDetail}
                </Text>
              ) : null}
            </Container>
          </Card>
          )}

          {action ? (
            <Card variant="nested" padding="md" className="border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]">
              {action}
            </Card>
          ) : null}

          {nextStep ? (
            <Card variant="nested" padding="md">
              <Container layout="vertical" gap="xs">
                <Text variant="label" color="faint">
                  Next
                </Text>
                <Text variant="body" weight="semibold" leading="relaxed">
                  {nextStep}
                </Text>
              </Container>
            </Card>
          ) : null}

          {children}

          {hasItemsBlock ? (
            <Card variant="ghost" padding="none" layout="stack">
              {itemsTitle ? (
                <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                  <Text variant="heading">
                    {itemsTitle}
                  </Text>
                  {items.length > 0 ? (
                    <Badge variant="neutral" size="sm">
                      {items.length}
                    </Badge>
                  ) : null}
                </Container>
              ) : null}
              {items.length > 0 ? (
                <Container layout="vertical" gap="sm">
                  {items.map((item, index) => (
                    <WorkItem key={item.key ?? index} item={item} />
                  ))}
                </Container>
              ) : (
                <Card variant="nested" padding="md">
                  <Container layout="vertical" gap="xs">
                    {emptyTitle ? (
                      <Text variant="body" weight="semibold">
                        {emptyTitle}
                      </Text>
                    ) : null}
                    {emptyDetail ? (
                      <Text variant="body-xs" color="faint" leading="relaxed">
                        {emptyDetail}
                      </Text>
                    ) : null}
                  </Container>
                </Card>
              )}
            </Card>
          ) : null}

          {details ? (
            <details className="rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-4 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-[var(--text-primary)]">
                {detailsTitle}
              </summary>
              <div className="pt-3">
                {details}
              </div>
            </details>
          ) : null}
        </Card>
      </Container>
    </ScrollableSurface>
  );
}
