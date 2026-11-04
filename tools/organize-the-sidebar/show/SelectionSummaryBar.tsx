// packages/group/show/SelectionSummaryBar.tsx
//
// The selection SUMMARY bar — the live "what did I just select?" readout at the top of the tools rail. A BLIND
// renderer of `selectionSummary(items, selectedIds).chips` (selection-summary.ts) into pill badges: it names no
// specific stat, it folds whatever chips the DATA-driven projection emits. Selecting 8 cards instantly shows
// "8 cards · 62% avg · 1/2 done · 3 dated"; adding a new stat is one CHIP_SPECS row, ZERO change here (L090).
// Nothing selected → nothing rendered (L118 — it exists only while it answers a live question).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Badge, Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { selectionSummary } from '../read-data/selection-summary';

export interface SelectionSummaryBarProps {
  readonly items: readonly BoardItem[];
  readonly selectedIds: readonly string[];
}

/** Render the current selection's intrinsic stat chips. Empty selection (or a selection whose items all fell
 *  away) → null, so the bar never shows an empty frame. */
export function SelectionSummaryBar({ items, selectedIds }: SelectionSummaryBarProps) {
  const { count, chips } = selectionSummary(items, selectedIds);
  if (count === 0 || chips.length === 0) return null;
  return (
    <Container layout="horizontal" gap="xs" padding="xs" wrap aria-label="Selection summary">
      <Text variant="label">{count} selected</Text>
      {chips.map((chip) => (
        <Badge key={chip.key} variant="neutral" size="sm">
          {chip.label}
        </Badge>
      ))}
    </Container>
  );
}
