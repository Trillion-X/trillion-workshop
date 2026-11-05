// packages/group/show/VoteRankingPanel.tsx
//
// The dot-voting "Top voted" panel — a thin DATA adapter over the generic RankedJumpList (the SAME list
// primitive the comments triage panel uses, L069/L100). It maps each vote-ranking row to a {label,
// badge} row (idea label + its vote count) and hands them to the blind list; a row click jumps to that
// idea. Zero list/layout code of its own — the two-caller proof that RankedJumpList is the primitive.

import { RankedJumpList, type RankedRow } from './RankedJumpList.tsx';
import type { VoteRankingRow } from '../do-work/board-votes-actions.ts';

export interface VoteRankingPanelProps {
  readonly rows: readonly VoteRankingRow[];
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

export function VoteRankingPanel({ rows, onJumpTo, onClose }: VoteRankingPanelProps): JSX.Element {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const listRows: RankedRow[] = rows.map((r) => ({
    id: r.memberId,
    label: r.label,
    badge: `${r.count}`,
  }));
  return (
    <RankedJumpList
      title="Top voted"
      subtitle={total > 0 ? `${total} votes` : undefined}
      rows={listRows}
      emptyText="No votes yet. Start voting and cast your dots."
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}
