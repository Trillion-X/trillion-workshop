// packages/workflow-canvas/show/CanvasEmptyState.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The canvas's two empty states, as a presentational component:
//
// - First run (no workflows yet): a reference-grounded ACTIONABLE start — a
//   tinted glyph, a heading, one sentence, and a primary "Add your first step"
//   button that opens the create flow. Lindy's first-run canvas is never a dead
//   text message; it shows an actionable "Select trigger" starting affordance.
//   This is the equivalent: the empty canvas invites the first real step.
//
// - Filtered (search / focus / kind chip active, nothing matches): a quiet
//   "Nothing matches" with one button back to everything.
//
// Zero domain vocabulary — the component takes plain callbacks; the canvas wires
// `onStart` to its create flow and `onClearFilters` to its filter reset.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ui primitives + tokens only; the only inline style is NodeIconFrame's
//    geometry (it owns its tinted surface via tokens).
// 2. Honest: shows the start affordance only when truly empty, the filter
//    reset only when a filter is hiding things (L117 — no fake content).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Button, Container, Text } from '../../ui';
import { NodeIconFrame } from './node-icon';

export interface CanvasEmptyStateProps {
  /** True when a search / focus / kind filter is active (so the canvas is empty
   *  because nothing matches — not because there are no workflows). */
  filtered: boolean;
  /** Open the create flow (the canvas bumps its create signal). */
  onStart: () => void;
  /** Clear the active search / focus / kind filter. */
  onClearFilters: () => void;
}

export const CanvasEmptyState: React.FC<CanvasEmptyStateProps> = ({
  filtered,
  onStart,
  onClearFilters,
}) => {
  if (filtered) {
    return (
      <Container layout="vertical" alignItems="center" gap="sm" data-workflow-empty="filtered">
        <Text variant="heading-sm" color="muted">Nothing matches</Text>
        <Text variant="body-sm" color="muted">Clear the search or show everything.</Text>
        <Button variant="secondary" size="sm" onClick={onClearFilters}>
          Show everything
        </Button>
      </Container>
    );
  }
  return (
    <Container layout="vertical" alignItems="center" gap="md" data-workflow-empty="first-run">
      {/* The welcoming start mark — the same tinted glyph frame the node cards
          use, so the empty canvas already speaks the canvas's visual language. */}
      <NodeIconFrame iconName="zap" accentTone="neutral" size={48} />
      <Container layout="vertical" alignItems="center" gap="xs">
        <Text variant="heading-sm">Build your first workflow</Text>
        <Text variant="body-sm" color="muted">
          Start with the step that kicks it off.
        </Text>
      </Container>
      <Button variant="primary" size="sm" onClick={onStart}>
        Add your first step
      </Button>
    </Container>
  );
};
