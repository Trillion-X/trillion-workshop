// bitfield/packages/ui/show/run-card/RunCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Grouped display for one work run: title, humanized status chip, a quiet
// line saying what the run was for, requested time, finished output fields,
// and safe error copy. Anatomy after 21st.dev Agent Elements' Tool Group
// (id 12423): a sentence-case state beside the title, the quiet detail under
// it, facts as label and value rows; no avatar and no case transform. Shared by every package
// that shows runs (content production, publishing, transcription, rendering)
// so run display stays identical product-wide.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No raw HTML/className — composes Card, Container, Badge, Text,
//    OutputFieldList, SafeErrorCard, statusView
// 2. The status chip always goes through statusView — raw states never render
// 3. Errors always go through SafeErrorCard sanitation
// 4. Ordering is the READER's job — this component never sorts
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Badge } from '../badge';
import { Card } from '../card';
import { Container } from '../container';
import { OutputFieldList, type OutputField } from '../output-field-list/OutputFieldList';
import { SafeErrorCard } from '../safe-error-card/SafeErrorCard';
import { statusView, type StatusOverrides } from '../status-vocabulary/StatusVocabulary';
import { Text } from '../text';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface RunCardProps {
  /** Human run title (e.g. the prompt's first words or "Untitled run"). */
  title: string;
  /** A quiet line under the title: what the run was for. Wraps; never cut. */
  detail?: string | null;
  /** Human time words (e.g. "Today, 2:14 PM"). */
  requestedAtLabel?: string;
  /** Raw status string — humanized internally via statusView. */
  status?: string | null;
  /** Package status overrides forwarded to statusView. */
  statusOverrides?: StatusOverrides;
  /** Finished output fields (already key/label/value shaped). */
  outputs?: OutputField[];
  /** Raw error message — sanitized internally. Hidden when absent. */
  errorMessage?: string | null;
  /** Retry handler for the error action. */
  onRetry?: () => void;
  /** Trailing custom content (links, secondary actions). */
  children?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

const TONE_TO_BADGE = {
  neutral: 'neutral',
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
} as const;

/**
 * One run: header row (title + status chip + time), outputs, safe error.
 */
export function RunCard({
  title,
  detail,
  requestedAtLabel,
  status,
  statusOverrides,
  outputs,
  errorMessage,
  onRetry,
  children,
}: RunCardProps): React.ReactElement {
  const view = statusView(status, statusOverrides);
  return (
    <Card variant="surface" padding="md">
      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="md" alignItems="start">
          <Container layout="vertical" gap="none" flex="grow">
            <Text variant="heading">{title}</Text>
            {detail ? <Text variant="body-xs" color="secondary">{detail}</Text> : null}
            {requestedAtLabel ? <Text variant="caption" color="faint">{requestedAtLabel}</Text> : null}
          </Container>
          <Badge variant={TONE_TO_BADGE[view.tone]} size="md">{view.label}</Badge>
        </Container>
        {outputs && outputs.length > 0 ? <OutputFieldList fields={outputs} /> : null}
        {view.isError || errorMessage ? (
          <SafeErrorCard message={errorMessage} onRetry={onRetry} />
        ) : null}
        {children}
      </Container>
    </Card>
  );
}
