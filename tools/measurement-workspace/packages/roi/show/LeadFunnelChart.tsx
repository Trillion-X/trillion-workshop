// packages/roi/show/LeadFunnelChart.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Chart showing lead funnel: new → qualified → converted with conversion rates.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Shows 3 stages: New Leads → Qualified → Converted
// 2. Displays count at each stage and conversion % between stages
// 3. All styling through @/packages/ui (L065/L066 compliant)
// 4. No raw HTML or inline styles
//
// =============================================================================

import * as React from 'react';
import { Container, Text, Card } from '@/packages/ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface LeadFunnelChartProps {
  newLeads: number;
  qualified: number;
  converted: number;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * LeadFunnelChart — displays lead conversion funnel.
 *
 * Shows stages: New → Qualified → Converted with counts and conversion rates.
 */
export const LeadFunnelChart: React.FC<LeadFunnelChartProps> = ({
  newLeads,
  qualified,
  converted,
}) => {
  const qualifyRate = newLeads > 0 ? Math.round((qualified / newLeads) * 100) : 0;
  const convertRate = qualified > 0 ? Math.round((converted / qualified) * 100) : 0;

  return (
    <Card variant="surface" padding="lg">
      <Container layout="vertical" gap="md">
        <Text variant="heading-xs" weight="semibold" color="strong">
          Lead Funnel
        </Text>

        {/* Stage 1: New */}
        <Container layout="vertical" gap="xs">
          <Text variant="caption" color="muted">
            New Leads
          </Text>
          <Text variant="heading-sm" weight="bold" color="strong">
            {newLeads.toLocaleString()}
          </Text>
        </Container>

        {/* Arrow + conversion rate */}
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="caption" color="muted">
            ↓ {qualifyRate}% qualify
          </Text>
        </Container>

        {/* Stage 2: Qualified */}
        <Container layout="vertical" gap="xs">
          <Text variant="caption" color="muted">
            Qualified
          </Text>
          <Text variant="heading-sm" weight="bold" color="accent">
            {qualified.toLocaleString()}
          </Text>
        </Container>

        {/* Arrow + conversion rate */}
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="caption" color="muted">
            ↓ {convertRate}% convert
          </Text>
        </Container>

        {/* Stage 3: Converted */}
        <Container layout="vertical" gap="xs">
          <Text variant="caption" color="muted">
            Converted
          </Text>
          <Text variant="heading-sm" weight="bold" color="success">
            {converted.toLocaleString()}
          </Text>
        </Container>
      </Container>
    </Card>
  );
};

LeadFunnelChart.displayName = 'LeadFunnelChart';

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

export type {};
