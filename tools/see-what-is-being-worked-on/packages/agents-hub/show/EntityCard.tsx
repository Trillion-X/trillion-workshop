// package-set://bitfield-studio/packages/agents-hub/show/EntityCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE card shape for every AI building block in the hub's top-level views
// (Models, Tools, Instructions, Memory, Runs, Permissions). Reference
// anatomy: Relevance AI marketplace cards (mobbin 583633c0…, 74f5465e…) —
// icon tile, name, quiet context line, 2-line description, footer meta row.
// Agents keep their richer AgentCard; everything else is a configuration of
// THIS card (L069 — one primitive, N kinds via props).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All content arrives as plain display strings — no record decoding here.
// 2. No internal vocabulary: callers pass human copy only.
// 3. Badge tone is data (`badgeTone`), not a per-kind branch.
//
// =============================================================================

import React from 'react';
import { Badge, Button, Card, Container, Dropdown, NamedIcon, Text } from '@/packages/ui';

/** One overflow-menu action — same shape as AgentCard's menu items. */
export interface EntityCardAction {
  value: string;
  label: string;
  icon: string;
  tint?: string;
}

export interface EntityCardProps {
  /** Lucide icon name for the leading tile. */
  icon: string;
  name: string;
  /** Quiet context under the name (provider, agent, kind). */
  context?: string;
  description?: string;
  /** Trailing badge (e.g. "Allowed", "Blocked", "Local"). */
  badge?: string;
  badgeTone?: 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'accent' | 'muted';
  /** Footer meta line (counts, timestamps — already formatted). */
  meta?: string;
  onOpen?: () => void;
  /** Overflow (3-dot) menu actions. Empty/omitted → no menu. */
  actions?: readonly EntityCardAction[];
  onAction?: (value: string) => void;
}

export const EntityCard = React.memo(function EntityCard({
  icon,
  name,
  context,
  description,
  badge,
  badgeTone = 'muted',
  meta,
  onOpen,
  actions,
  onAction,
}: EntityCardProps) {
  const hasMenu = Boolean(actions && actions.length > 0 && onAction);
  return (
    <Card
      variant="surface"
      padding="md"
      interactive={Boolean(onOpen)}
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      aria-label={name}
    >
      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Card variant="nested" padding="xs">
            <NamedIcon name={icon} size="sm" />
          </Card>
          <Container layout="vertical" flex="1" overflow="hidden">
            <Text variant="body" weight="semibold" truncate>{name}</Text>
            {context && <Text variant="caption" color="faint" truncate>{context}</Text>}
          </Container>
          {badge && <Badge variant={badgeTone}>{badge}</Badge>}
          {hasMenu && (
            <Dropdown
              items={actions as EntityCardAction[]}
              value=""
              onValueChange={(value) => onAction?.(value)}
              customTrigger={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`${name} actions`}
                  onClick={(event: React.MouseEvent) => event.stopPropagation()}
                >
                  <NamedIcon name="MoreHorizontal" size="sm" />
                </Button>
              }
              align="end"
            />
          )}
        </Container>
        {description && (
          <Text variant="body-xs" color="muted" clamp={2}>{description}</Text>
        )}
        {meta && (
          <Text variant="caption" color="faint" truncate>{meta}</Text>
        )}
      </Container>
    </Card>
  );
});
