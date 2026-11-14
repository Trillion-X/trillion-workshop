// bitfield/packages/ui/show/safe-error-card/SafeErrorCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The one shared way a package surface shows a failure to a human. Accepts a
// raw error message, SANITIZES it (strips stack frames, absolute paths,
// package addresses, hashes, raw JSON dumps), and renders calm copy with a
// retry action. A raw backend error string can never reach visible copy
// through this component.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No raw HTML/className — composes Card, Container, Icon, Text, Button
// 2. sanitizeErrorText() is the single sanitation gate; every visible string
//    passes through it
// 3. The title is always human ("Needs attention" by default) — never "Error:"
// 4. Internal diagnostic identifiers never render to the person
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../button';
import { Card } from '../card';
import { Container } from '../container';
import { Icon } from '../icon';
import { Text } from '../text';
import { sanitizeErrorText } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

// ---------------------------------------------------------------------------
// SANITATION: the one gate lives in ./sanitize-error-text.ts.
// ---------------------------------------------------------------------------

export { sanitizeErrorText };

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface SafeErrorCardProps {
  /** Raw message — sanitized before render. */
  message?: string | null;
  /** Human title. Default: "Needs attention". */
  title?: string;
  /** Retry button label. Default: "Try again". Hidden when onRetry is absent. */
  retryLabel?: string;
  /** Retry handler — renders the action button when present. */
  onRetry?: () => void;
  /** Fallback sentence when sanitation strips everything. */
  fallbackText?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Calm failure card: icon, human title, sanitized message, retry action.
 */
export function SafeErrorCard({
  message,
  title = 'Needs attention',
  retryLabel = 'Try again',
  onRetry,
  fallbackText,
}: SafeErrorCardProps): React.ReactElement {
  const safeText = sanitizeErrorText(message, fallbackText);
  return (
    <Card variant="surface" padding="md">
      <Container layout="horizontal" gap="md" alignItems="start">
        <Icon icon={AlertTriangle} size="md" color="warning" />
        <Container layout="vertical" gap="sm" flex="grow">
          <Text variant="heading">{title}</Text>
          <Text variant="body-xs" color="secondary">{safeText}</Text>
          {onRetry ? (
            <Container layout="horizontal" gap="sm">
              <Button variant="secondary" size="sm" onClick={onRetry}>{retryLabel}</Button>
            </Container>
          ) : null}
        </Container>
      </Container>
    </Card>
  );
}
