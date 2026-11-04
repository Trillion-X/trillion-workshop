// packages/group/show/TimeRankPanel.tsx
//
// The "Time" ranking panel — a thin DATA adapter over the generic RankedJumpList (the SAME list the
// comments-triage, vote-ranking, due-soon, streak, and progress panels use, L069/L100). It maps each
// effort row to a {label, note, badge} row (item label + session-count note + total/recent time badge)
// and hands them to the blind list; a row click jumps to that item. The SIXTH caller of RankedJumpList
// — the primitive holds across six surfaces.

import { RankedJumpList, type RankedRow } from './RankedJumpList';
import { formatDuration } from '../read-data/board-time-log';
import type { TimeRankRow } from '../do-work/board-time-log-actions';

export interface TimeRankPanelProps {
  readonly rows: readonly TimeRankRow[];
  /** Whether these rows are "recent" (windowed) or "total" — only changes the title/subtitle wording. */
  readonly recent?: boolean;
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

export function TimeRankPanel({ rows, recent = false, onJumpTo, onClose }: TimeRankPanelProps): JSX.Element {
  const listRows: RankedRow[] = rows.map((r) => ({
    id: r.memberId,
    label: r.label,
    note: `${r.sessions} ${r.sessions === 1 ? 'session' : 'sessions'}`,
    badge: formatDuration(r.ms),
  }));
  return (
    <RankedJumpList
      title={recent ? 'Recent work' : 'Most time'}
      subtitle={rows.length > 0 ? `${rows.length} tracked` : undefined}
      rows={listRows}
      emptyText="No time logged yet. Start a timer or add minutes to a card."
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}
