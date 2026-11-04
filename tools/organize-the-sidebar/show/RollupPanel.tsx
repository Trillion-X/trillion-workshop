// packages/group/show/RollupPanel.tsx
//
// The breakdown surface for the goal-rollup primitive: the sub-goals under one vision, each with its
// effective progress, over the generic RankedJumpList (the EIGHTH caller). The header summarises the
// rolled-up aggregate honestly — "72% · 2/3 tracked", or "No measured child progress" when none of the
// children carry a metric (no fake 0%, per the Codex convergence). A row jumps to that sub-goal. ui only.

import { RankedJumpList, type RankedRow } from './RankedJumpList';
import type { RollupResult } from '../read-data/board-rollup';
import type { RollupChild } from '../do-work/board-rollup-actions';

export interface RollupPanelProps {
  readonly parentLabel: string;
  readonly summary: RollupResult;
  readonly children: readonly RollupChild[];
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

export function RollupPanel({ parentLabel, summary, children, onJumpTo, onClose }: RollupPanelProps): JSX.Element {
  const rows: RankedRow[] = children.map((c) => ({
    id: c.memberId,
    label: c.label,
    badge: c.result.value !== undefined ? `${Math.round(c.result.value * 100)}%` : '—',
  }));
  const subtitle =
    summary.fraction !== undefined
      ? `${Math.round(summary.fraction * 100)}% · ${summary.contributingChildCount}/${summary.childCount} tracked`
      : 'No measured child progress';
  return (
    <RankedJumpList
      title={parentLabel}
      subtitle={subtitle}
      rows={rows}
      emptyText="No sub-goals under this card."
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}
