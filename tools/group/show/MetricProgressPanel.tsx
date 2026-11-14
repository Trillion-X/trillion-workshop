// packages/group/show/MetricProgressPanel.tsx
//
// The "Progress" panel — a thin DATA adapter over the generic RankedJumpList (the SAME list primitive
// the comments-triage, vote-ranking, due-soon, and streak panels use, L069/L100). It maps each metric
// row to a {label, note, badge} row (goal label + "5/12 books" note + "N%" badge) and hands them to the
// blind list; a row click jumps to that goal. The FIFTH caller of RankedJumpList — the primitive holds
// across five surfaces.

import { RankedJumpList, type RankedRow } from './RankedJumpList';
import { formatValue } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-metric.ts';
import type { MetricRankRow } from '../do-work/board-metric-actions';

export interface MetricProgressPanelProps {
  readonly rows: readonly MetricRankRow[];
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

export function MetricProgressPanel({ rows, onJumpTo, onClose }: MetricProgressPanelProps): JSX.Element {
  const listRows: RankedRow[] = rows.map((r) => ({
    id: r.memberId,
    label: r.label,
    note: formatValue(r.metric),
    badge: `${r.pct}%`,
  }));
  return (
    <RankedJumpList
      title="Progress"
      subtitle={rows.length > 0 ? `${rows.length} tracked` : undefined}
      rows={listRows}
      emptyText="No measured goals yet. Add a metric to a card to track a number."
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}
