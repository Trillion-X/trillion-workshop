// packages/group/show/ReviewPanel.tsx
//
// The board "Review" surface: the board-level lenses stacked in ONE panel — "Needs attention" (risk),
// "On a roll" (momentum), and "Almost there" (finish-line / proximity-to-done). All are DATA registries
// fed to the SAME blind weighted-signal engine (read-data/board-weighted-signals); this panel just stacks
// EMBEDDED RankedJumpList sections under one header + Close (per the Codex convergence: a single Review
// surface earns each lens its keep as a section, rather than a standalone header button per lens). The
// three answer the three questions a goal board is for: what is slipping, what is moving, and what can I
// close out. When a `digest` is provided, a VERDICT-FIRST banner (the board's one-line self-assessment +
// the single next action) sits above the sections — you read what to do before scanning the lists. ui
// only (L065).

import { Button, Card, Container, Text } from '../../ui';
import { RankedJumpList, type RankedRow } from './RankedJumpList';
import type { AttentionRankRow } from '../do-work/board-attention-actions';
import type { MomentumRankRow } from '../do-work/board-momentum-actions';
import type { FinishLineRankRow } from '../do-work/board-finish-line-actions';
import type { BoardDigest } from '../do-work/board-digest-actions';

export interface ReviewPanelProps {
  readonly attention: readonly AttentionRankRow[];
  readonly momentum: readonly MomentumRankRow[];
  readonly finishLine: readonly FinishLineRankRow[];
  /** The board's self-assessment; when present, its headline + next action render as a verdict banner. */
  readonly digest?: BoardDigest;
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

const toRows = (rows: readonly { memberId: string; label: string; reasons: readonly string[] }[]): RankedRow[] =>
  rows.map((r) => ({ id: r.memberId, label: r.label, note: r.reasons.join(' · ') }));

export function ReviewPanel({ attention, momentum, finishLine, digest, onJumpTo, onClose }: ReviewPanelProps): JSX.Element {
  const noop = () => {};
  return (
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="md" style={{ minWidth: 280, maxWidth: 340 }}>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-md" weight="semibold">Review</Text>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close review panel">Close</Button>
        </Container>

        {digest ? (
          <Container layout="vertical" gap="xs">
            <Text variant="body-sm" weight="semibold" aria-label={`Board summary: ${digest.headline}`}>{digest.headline}</Text>
            {digest.next ? (
              <Button variant="secondary" size="sm" onClick={() => onJumpTo(digest.next!.memberId)} aria-label={`Next: ${digest.next.label} — ${digest.next.reason}`}>
                <Text variant="caption">{`Next: ${digest.next.label} · ${digest.next.reason}`}</Text>
              </Button>
            ) : null}
          </Container>
        ) : null}

        <RankedJumpList
          embedded
          title="Needs attention"
          subtitle={attention.length > 0 ? `${attention.length} to review` : undefined}
          rows={toRows(attention)}
          emptyText="Nothing needs attention — no overdue, stalled, or lapsed cards."
          onJumpTo={onJumpTo}
          onClose={noop}
        />

        <RankedJumpList
          embedded
          title="On a roll"
          subtitle={momentum.length > 0 ? `${momentum.length} with momentum` : undefined}
          rows={toRows(momentum)}
          emptyText="No momentum yet — log effort or keep a streak going."
          onJumpTo={onJumpTo}
          onClose={noop}
        />

        <RankedJumpList
          embedded
          title="Almost there"
          subtitle={finishLine.length > 0 ? `${finishLine.length} to close out` : undefined}
          rows={toRows(finishLine)}
          emptyText="Nothing almost done yet — cards past 75% appear here, closest first."
          onJumpTo={onJumpTo}
          onClose={noop}
        />
      </Container>
    </Card>
  );
}
