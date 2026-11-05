// packages/group/show/CommentsReviewPanel.tsx
//
// The comments TRIAGE panel — now a thin DATA adapter over the generic RankedJumpList (L069/L100): it
// maps each comment thread to a {label, note, badge} row (item label + "author: preview" + count/
// resolved) and hands them to the blind list. A row click jumps to that anchor. Zero list/layout code
// of its own — the list primitive owns rendering; this owns only the comments→row mapping.

import { RankedJumpList, type RankedRow } from './RankedJumpList.tsx';
import type { CommentReviewRow } from '../do-work/board-comments-actions.ts';

export interface CommentsReviewPanelProps {
  readonly rows: readonly CommentReviewRow[];
  readonly onJumpTo: (anchorId: string) => void;
  readonly onClose: () => void;
}

export function CommentsReviewPanel({ rows, onJumpTo, onClose }: CommentsReviewPanelProps): JSX.Element {
  const openCount = rows.filter((r) => r.summary.open).length;
  const listRows: RankedRow[] = rows.map((r) => ({
    id: r.anchorId,
    label: r.label,
    badge: r.summary.resolved ? 'resolved' : `${r.summary.count}`,
    note: r.summary.preview ? `${r.summary.lastAuthor ?? ''}: ${r.summary.preview}` : undefined,
  }));
  return (
    <RankedJumpList
      title="Comments"
      subtitle={openCount > 0 ? `${openCount} open` : 'all resolved'}
      rows={listRows}
      emptyText="No comments yet. To start one:"
      emptySteps={[
        'Click a card on the board',
        'Press the Comment button that appears in the toolbar',
      ]}
      jumpVerb="comments on"
      onJumpTo={onJumpTo}
      onClose={onClose}
    />
  );
}
