// packages/group/show/DueSoonPanel.tsx
//
// The "Due soon" panel — a thin DATA adapter over the generic RankedJumpList (the SAME list primitive
// the comments-triage + vote-ranking panels use, L069/L100). It maps each due row to a {label, badge}
// row (item label + relative-time badge like "in 3 days" / "Yesterday") and hands them to the blind
// list; a row click jumps to that item. The third caller of RankedJumpList — the primitive holds.

import { RankedJumpList, type RankedRow } from './RankedJumpList.tsx';
import type { DueRow } from '../do-work/board-due-date-actions.ts';

export interface DueSoonPanelProps {
  readonly rows: readonly DueRow[];
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

export function DueSoonPanel({ rows, onJumpTo, onClose }: DueSoonPanelProps): JSX.Element {
  const overdue = rows.filter((r) => r.relative.overdue).length;
  const listRows: RankedRow[] = rows.map((r) => ({
    id: r.memberId,
    label: r.label,
    badge: r.relative.label,
  }));
  return (
    <RankedJumpList
      title="Due soon"
      subtitle={overdue > 0 ? `${overdue} overdue` : rows.length > 0 ? `${rows.length} scheduled` : undefined}
      rows={listRows}
      emptyText="Nothing scheduled. Give an item a due date."
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}
