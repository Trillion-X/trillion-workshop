// package-set://bitfield-studio/packages/marketing-pipeline/show/issue-banner.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The recoverable-issue region: a calm banner above the workbench that surfaces
// each recoverable issue and, when the issue names a retry action, offers a
// bound "try again" that re-runs THAT action's work. The retry is wired to the
// issue's `retryActionRef` (DATA) — the banner names no action and no domain.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Retry is DATA-bound (L090): the button appears only when the issue carries
//    a `retryActionRef` that resolves to an action descriptor, and its label is
//    that action's label. No hardcoded "retry send" — the data decides.
// 2. Severity is a presentation mapping in the show layer (L098): the raw
//    severity string from data maps to a SeverityRow level here, never upstream.
// 3. Messages are already human copy in the data; SafeErrorCard sanitizes them
//    so no internal token can leak (L114/L118).
// 4. Composes shared `ui` atoms only — no raw HTML, no className (L065).
//
// =============================================================================

import React from 'react';
import { Container, SafeErrorCard, SeverityRow } from '@/packages/ui';
import type {
  CoordinationActionDescriptor,
  CoordinationRecoverableIssue,
} from '../read-data/read-coordination-records';

/** Map a raw authored severity onto the SeverityRow's fixed visual levels. */
function severityLevel(raw: string): 'critical' | 'warning' | 'info' {
  const value = raw.toLowerCase();
  if (value === 'critical' || value === 'error' || value === 'blocked') return 'critical';
  if (value === 'info' || value === 'notice') return 'info';
  return 'warning';
}

export interface IssueBannerProps {
  issues: CoordinationRecoverableIssue[];
  /** Resolve an issue's `retryActionRef` to its action descriptor (DATA). */
  resolveAction: (actionId: string) => CoordinationActionDescriptor | undefined;
  /** Run the resolved retry action for an issue. */
  onRetry: (action: CoordinationActionDescriptor, issue: CoordinationRecoverableIssue) => void;
}

/** Stacked recoverable-issue cards, each with a DATA-bound retry when available. */
export function IssueBanner({ issues, resolveAction, onRetry }: IssueBannerProps): React.ReactElement | null {
  if (issues.length === 0) return null;
  return (
    <Container layout="vertical" gap="sm" aria-label="Needs attention">
      {issues.map((issue) => {
        const retryAction = issue.retryActionRef ? resolveAction(issue.retryActionRef) : undefined;
        return (
          <SeverityRow key={issue.id} severity={severityLevel(issue.severity)}>
            <SafeErrorCard
              message={issue.message}
              retryLabel={retryAction?.label}
              onRetry={retryAction ? () => onRetry(retryAction, issue) : undefined}
            />
          </SeverityRow>
        );
      })}
    </Container>
  );
}

export default IssueBanner;
