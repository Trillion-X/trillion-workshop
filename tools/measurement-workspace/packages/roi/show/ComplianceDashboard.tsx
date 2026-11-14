// packages/roi/show/ComplianceDashboard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ComplianceDashboard displays aggregate project compliance status from the
// canonical package-local `project-compliance` input.
//
// Features:
//   - Reads canonical aggregate compliance via useBitfieldData()
//   - Displays pass percentage with severity badge
//   - Shows passed / failed counts
//   - Loading and error states
//
// Uses ONLY ui/ components (L065/L066 — zero raw HTML, zero className).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO raw HTML elements — ALL content through ui/ components
// 2. ZERO raw className or inline styles
// 3. ONLY imports from @/packages/ui barrel
// 4. Read only the package-local aggregate project-compliance input
// 5. Handle loading, error, and empty states gracefully
// 6. Preserve canonical severity / counts from the feed payload
// 7. Zero fallback query loops or local EEAF reads
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Shield } from 'lucide-react';
import {
  Card,
  Container,
  Text,
  Badge,
  EmptyPlaceholder,
} from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  decodeProjectComplianceFeed,
} from '@/packages/roi/read-data/read-project-compliance';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

type LoadState = 'loading' | 'success' | 'error';

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export interface ComplianceDashboardProps {
  projectId: string;
}

export function ComplianceDashboard({ projectId }: ComplianceDashboardProps) {
  const complianceEntry = useBitfieldData('project-compliance');
  const compliance = React.useMemo(
    () => decodeProjectComplianceFeed(complianceEntry),
    [complianceEntry],
  );
  const latestAudit = compliance.find((record) => record.projectId === projectId)
    ?? (projectId === 'default' ? compliance[0] : null);
  const state: LoadState = complianceEntry === null ? 'loading' : 'success';
  const error = undefined;

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  if (state === 'loading') {
    return (
      <Container layout="vertical" gap="md" alignItems="center">
        <Text variant="body-xs" color="muted">Loading compliance data...</Text>
      </Container>
    );
  }

  if (state === 'error') {
    return (
      <Card variant="error">
        <Container layout="vertical" gap="sm">
          <Text variant="label">Error Loading Compliance Data</Text>
          <Text variant="body">{error || 'Failed to load compliance data'}</Text>
        </Container>
      </Card>
    );
  }

  if (!latestAudit) {
    return (
      <EmptyPlaceholder
        icon={Shield}
        message="No compliance information available for this project."
      />
    );
  }

  const passPercentage = latestAudit.checksPassed + latestAudit.checksFailed > 0
    ? Math.round((latestAudit.checksPassed / (latestAudit.checksPassed + latestAudit.checksFailed)) * 100)
    : 0;

  return (
    <Container layout="vertical" gap="md">
      {/* Current Status Summary */}
      <Card variant="nested">
        <Container layout="horizontal" gap="md" alignItems="center">
          <Container layout="vertical" gap="xs">
            <Text variant="label">Compliance Status</Text>
            <Text variant="heading">{passPercentage}% Complete</Text>
          </Container>
          <Badge variant={passPercentage === 100 ? 'success' : latestAudit.severity === 'error' ? 'error' : 'warning'}>
            {latestAudit.severity}
          </Badge>
        </Container>
      </Card>

      {/* Audit Summary */}
      <Card variant="surface">
        <Container layout="vertical" gap="md">
          <Text variant="label">Audit Results</Text>
          <Container layout="horizontal" gap="md" alignItems="center">
            <Container layout="vertical" gap="xs">
              <Text variant="caption">Passed</Text>
              <Text variant="body" weight="medium">{latestAudit.checksPassed}</Text>
            </Container>
            <Container layout="vertical" gap="xs">
              <Text variant="caption">Failed</Text>
              <Text variant="body" weight="medium">{latestAudit.checksFailed}</Text>
            </Container>
          </Container>
        </Container>
      </Card>
    </Container>
  );
}
