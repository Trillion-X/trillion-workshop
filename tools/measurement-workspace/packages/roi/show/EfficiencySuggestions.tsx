// packages/roi/show/EfficiencySuggestions.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// EfficiencySuggestions component displays optimization recommendations.
// Shows suggestions with category, description, estimated savings, and confidence.
//
// Features:
//   - Reads package-local efficiency suggestion input
//   - Displays list of suggestions with category badges
//   - Shows estimated savings and confidence levels
//   - Renders evidence summary
//   - Loading and empty states
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
// 4. Read efficiency suggestions via `useBitfieldData('efficiency-suggestions')`
// 5. Handle loading, error, and empty states gracefully
// 6. Display category badges with appropriate color variants
// 7. Show confidence as percentage (0-100)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Lightbulb } from 'lucide-react';
import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  Card,
  Container,
  Text,
  Badge,
  EmptyPlaceholder,
} from '../../../../ui';
import {
  decodeEfficiencySuggestionsFeed,
} from '@/packages/roi/read-data/read-efficiency-suggestions';

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

/**
 * Map efficiency category to badge variant.
 */
function categoryToVariant(
  category: string
): 'neutral' | 'success' | 'warning' | 'error' | 'accent' {
  if (category === 'cost_reduction') return 'error';
  if (category === 'quality_improvement') return 'success';
  if (category === 'speed') return 'warning';
  if (category === 'model_substitution') return 'accent';
  return 'neutral';
}

/**
 * Format category label for display.
 */
function formatCategory(category: string): string {
  return category
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format savings value (handles currency and percentages).
 */
function formatSavings(savings: number | undefined): string {
  if (savings === undefined) return 'N/A';
  if (savings < 1) {
    return `${(savings * 100).toFixed(1)}%`;
  }
  return `$${savings.toFixed(2)}`;
}

/**
 * Format confidence as percentage.
 */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export interface EfficiencySuggestionsProps {
  projectId?: string;
}

export function EfficiencySuggestions({ projectId = 'default' }: EfficiencySuggestionsProps) {
  const suggestionsEntry = useBitfieldData('efficiency-suggestions');
  const allSuggestions = React.useMemo(
    () => decodeEfficiencySuggestionsFeed(suggestionsEntry),
    [suggestionsEntry],
  );
  const suggestions = allSuggestions.filter(
    (suggestion) => projectId === 'default' || suggestion.projectId === projectId,
  );

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  if (suggestionsEntry === null) {
    return (
      <Container layout="vertical" gap="md" alignItems="center">
        <Text variant="body-xs" color="muted">Loading suggestions...</Text>
      </Container>
    );
  }

  if (false) {
    return (
      <EmptyPlaceholder
        icon={Lightbulb}
        message="Unable to load efficiency suggestions."
      />
    );
  }

  if (suggestions.length === 0) {
    return (
      <EmptyPlaceholder
        icon={Lightbulb}
        message="System is running efficiently. No optimization suggestions at this time."
      />
    );
  }

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading-xl">Efficiency Suggestions</Text>

      <Container layout="vertical" gap="xs">
        {suggestions.map((suggestion) => (
          <Card key={suggestion.id} variant="surface" padding="sm">
            <Container layout="vertical" gap="xs">
              {/* Header with title and category */}
              <Container layout="horizontal" gap="md" alignItems="start">
                <Container flex={1}>
                  <Text variant="body">{suggestion.title}</Text>
                </Container>
                <Badge variant={categoryToVariant(suggestion.category)}>
                  {formatCategory(suggestion.category)}
                </Badge>
              </Container>

              {/* Description */}
              <Text variant="caption">{suggestion.description}</Text>

              {/* Metrics and action row */}
              <Container layout="horizontal" gap="md" alignItems="center">
                {suggestion.estimatedSavings !== undefined && (
                  <Text variant="body-xs">
                    Savings: {formatSavings(suggestion.estimatedSavings)}
                  </Text>
                )}

                <Text variant="body-xs">
                  Confidence: {formatConfidence(suggestion.confidence)}
                </Text>

                {suggestion.action && (
                  <Text variant="body-xs">{suggestion.action}</Text>
                )}
              </Container>
            </Container>
          </Card>
        ))}
      </Container>
    </Container>
  );
}
