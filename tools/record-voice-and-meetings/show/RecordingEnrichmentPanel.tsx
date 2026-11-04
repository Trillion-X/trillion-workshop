// package-set://bitfield-studio/packages/record-audio/show/RecordingEnrichmentPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The AI read of a finished recording on the recording page: a calm summary
// plus optional title / subtitle suggestions the person accepts with one click.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. It never overwrites anything on its own. The recording's own label and
//    subtitle stay authoritative (L117). Applying a suggestion routes through
//    the same owner actions the inline editors use — an explicit person action.
// 2. A suggestion appears only when it differs from what the person already has;
//    when there is nothing to add the panel renders nothing (L118 — no filler).
// 3. All styling through @/packages/ui primitives — no raw elements, no inline
//    style (L065).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import { Button, Container, Text } from '../../ui';
import type { RecordingEnrichment } from '../read-data/recording-enrichment';

type RecordingEnrichmentPanelProps = {
  enrichment: RecordingEnrichment;
  currentLabel: string;
  currentSubtitle: string;
  onApplyTitle: (title: string) => void;
  onApplySubtitle: (subtitle: string) => void;
};

// One enrichment field row: a faint label, the value, and (for suggestions) a
// quiet Use button — the same calm metadata-row shape the recording page uses
// for Created / Length, so the AI read sits flush with the rest of the page.
function EnrichmentRow({
  label,
  children,
  action,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Container layout="horizontal" gap="md" alignItems="start">
      <Container layout="vertical" gap="none" className="w-24 shrink-0">
        <Text variant="body-xs" color="faint">{label}</Text>
      </Container>
      <Container layout="vertical" gap="none" flex={1} className="min-w-0">
        {children}
      </Container>
      {action ?? null}
    </Container>
  );
}

export function RecordingEnrichmentPanel({
  enrichment,
  currentLabel,
  currentSubtitle,
  onApplyTitle,
  onApplySubtitle,
}: RecordingEnrichmentPanelProps) {
  const titleSuggestion =
    enrichment.title && enrichment.title !== currentLabel.trim() ? enrichment.title : '';
  const subtitleSuggestion =
    enrichment.subtitle && enrichment.subtitle !== currentSubtitle.trim() ? enrichment.subtitle : '';
  if (!enrichment.summary && !titleSuggestion && !subtitleSuggestion) return null;

  return (
    <Container layout="vertical" gap="md">
      {enrichment.summary ? (
        <EnrichmentRow label="Summary">
          <Text variant="body" wrap="preserve">{enrichment.summary}</Text>
        </EnrichmentRow>
      ) : null}
      {titleSuggestion ? (
        <EnrichmentRow
          label="Suggested name"
          action={(
            <Button variant="ghost" size="sm" onClick={() => onApplyTitle(titleSuggestion)}>Use</Button>
          )}
        >
          <Text variant="body">{titleSuggestion}</Text>
        </EnrichmentRow>
      ) : null}
      {subtitleSuggestion ? (
        <EnrichmentRow
          label="Suggested subtitle"
          action={(
            <Button variant="ghost" size="sm" onClick={() => onApplySubtitle(subtitleSuggestion)}>Use</Button>
          )}
        >
          <Text variant="body" color="subtle">{subtitleSuggestion}</Text>
        </EnrichmentRow>
      ) : null}
    </Container>
  );
}
