// packages/group/show/ImportancePanel.tsx
//
// The CORE-IDEAS panel — the projection surface for the PageRank importance primitive (board-importance), a thin
// DATA adapter over the generic RankedJumpList (the SAME list the forecast, time-rank, vote, streak, due-soon,
// and comments-triage panels use — L069/L100, one more caller and the primitive holds). Each row reads in the
// user's language: the card title, a "% of influence" badge (its share of the board's total transitive weight),
// and an endorsement note ("5 links in"). "Core ideas" answers "which cards does everything trace back to?" —
// the transitive signal raw degree cannot see. A row click jumps to that card. ui only, stateless.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { RankedJumpList, type RankedRow } from './RankedJumpList';
import type { ImportanceRow, ImportanceSummary } from '../do-work/board-importance-actions';

export interface ImportancePanelProps {
  readonly rows: readonly ImportanceRow[];
  readonly summary: ImportanceSummary;
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
  readonly embedded?: boolean;
}

/** The muted second line — how many cards point AT this one (its direct endorsements). */
function endorsementNote(row: ImportanceRow): string | undefined {
  if (row.endorsers <= 0) return undefined;
  return `${row.endorsers} ${row.endorsers === 1 ? 'link in' : 'links in'}`;
}

export function ImportancePanel({ rows, summary, onJumpTo, onClose, embedded }: ImportancePanelProps): JSX.Element {
  const listRows: RankedRow[] = rows.map((r) => ({
    id: r.memberId,
    label: r.label,
    badge: `${Math.round(r.score * 100)}%`,
    note: endorsementNote(r),
  }));
  const subtitle = summary.ranked > 0 ? `${summary.ranked} ranked · top ${Math.round(summary.topShare * 100)}%` : undefined;
  return (
    <RankedJumpList
      title="Core ideas"
      subtitle={subtitle}
      rows={listRows}
      emptyText="No cards yet. Add cards and link them — the ones everything points to rise to the top."
      jumpVerb="jump to"
      embedded={embedded}
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}
