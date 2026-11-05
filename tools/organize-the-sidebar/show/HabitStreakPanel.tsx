// packages/group/show/HabitStreakPanel.tsx
//
// The "Streaks" panel — a thin DATA adapter over the generic RankedJumpList (the SAME list primitive
// the comments-triage, vote-ranking, and due-soon panels use, L069/L100). It maps each streak row to a
// {label, badge} row (habit label + "🔥 N" streak) and hands them to the blind list; a row click jumps
// to that habit. The FOURTH caller of RankedJumpList — the primitive holds across four surfaces.

import { RankedJumpList, type RankedRow } from './RankedJumpList.tsx';
import type { StreakRankRow } from '../do-work/board-habit-actions.ts';

export interface HabitStreakPanelProps {
  readonly rows: readonly StreakRankRow[];
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

/** The period word for a cadence readout note ("today" / "this week" / "this month"). */
const PERIOD_WORD: Record<'day' | 'week' | 'month', string> = { day: 'today', week: 'this week', month: 'this month' };

export function HabitStreakPanel({ rows, onJumpTo, onClose }: HabitStreakPanelProps): JSX.Element {
  const listRows: RankedRow[] = rows.map((r) => ({
    id: r.memberId,
    label: r.label,
    // A cadence habit's streak is in PERIODS; the fire count still reads as commitment. Non-cadence stays "🔥 N".
    badge: `\u{1F525} ${r.streak}`,
    // For a cadence habit, show this period's progress + the target so a "3x/week" habit reads honestly.
    note: r.cadence ? `${r.cadence.done} of ${r.cadence.target} ${PERIOD_WORD[r.cadence.period]} · ${r.cadence.label}` : undefined,
  }));
  return (
    <RankedJumpList
      title="Streaks"
      subtitle={rows.length > 0 ? `${rows.length} active` : undefined}
      rows={listRows}
      emptyText="No streaks yet. Log a habit today to start one."
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}
