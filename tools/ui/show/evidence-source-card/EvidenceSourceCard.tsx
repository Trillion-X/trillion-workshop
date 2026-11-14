// bitfield/packages/ui/show/evidence-source-card/EvidenceSourceCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Responsive list/card primitive for one pickable source item (a file, a
// recording, a finished output) with an origin chip and an always-visible
// primary action. Desktop renders a compact row; small layouts render a
// full-width card — the action is never hover-only, so touch users always
// see it.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No raw HTML/className — composes Card, Container, Icon, Text, Badge, Button
// 2. All visible strings arrive ALREADY humanized (label, originLabel,
//    kindLabel) — this component never sees raw refs or ids except the opaque
//    selection key
// 3. The primary action is always visible — never revealed on hover
// 4. `selected` renders through the Card selected variant, not custom styling
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { LucideProps } from 'lucide-react';
import { Badge } from '../badge';
import { Button } from '../button';
import { Card } from '../card';
import { Container } from '../container';
import { Icon } from '../icon';
import { Text } from '../text';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface EvidenceSourceCardProps {
  /** Opaque selection key — never rendered. */
  id: string;
  /** Human item name. */
  label: string;
  /** Human origin words (e.g. "This computer", "Recordings", "Made here"). */
  originLabel: string;
  /** Human kind words when known (e.g. "Video", "Audio", "Blog post"). */
  kindLabel?: string;
  /** Human freshness words when known (e.g. "Today, 2:14 PM"). */
  dateLabel?: string;
  /** Leading icon when the caller has one. */
  icon?: React.ElementType<LucideProps>;
  /** Selected state — renders the Card selected treatment. */
  selected?: boolean;
  /** Always-visible primary action label. */
  actionLabel: string;
  /** Primary action handler. */
  onAction: (id: string) => void;
  /** Compact row (desktop list) vs full-width card (small layouts). */
  density?: 'row' | 'card';
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * One pickable source. Row density: name + chips left, action right.
 * Card density: stacked with a full-width action.
 */
export function EvidenceSourceCard({
  id,
  label,
  originLabel,
  kindLabel,
  dateLabel,
  icon,
  selected = false,
  actionLabel,
  onAction,
  density = 'row',
}: EvidenceSourceCardProps): React.ReactElement {
  const chips = (
    <Container layout="horizontal" gap="sm" alignItems="center">
      <Badge variant="muted" size="sm">{originLabel}</Badge>
      {kindLabel ? <Badge variant="neutral" size="sm">{kindLabel}</Badge> : null}
      {dateLabel ? <Text variant="caption" color="faint">{dateLabel}</Text> : null}
    </Container>
  );

  if (density === 'card') {
    return (
      <Card variant="surface" padding="md" selected={selected}>
        <Container layout="vertical" gap="sm">
          <Container layout="horizontal" gap="sm" alignItems="center">
            {icon ? <Icon icon={icon} size="md" color="muted" /> : null}
            <Text variant="heading" truncate>{label}</Text>
          </Container>
          {chips}
          <Button variant={selected ? 'success' : 'secondary'} size="sm" onClick={() => onAction(id)}>
            {selected ? 'Selected' : actionLabel}
          </Button>
        </Container>
      </Card>
    );
  }

  return (
    <Card variant="surface" padding="sm" selected={selected}>
      <Container layout="horizontal" gap="md" alignItems="center">
        {icon ? <Icon icon={icon} size="md" color="muted" /> : null}
        <Container layout="vertical" gap="none" flex="grow">
          <Text variant="body" truncate>{label}</Text>
          {chips}
        </Container>
        <Button variant={selected ? 'success' : 'secondary'} size="sm" onClick={() => onAction(id)}>
          {selected ? 'Selected' : actionLabel}
        </Button>
      </Container>
    </Card>
  );
}
