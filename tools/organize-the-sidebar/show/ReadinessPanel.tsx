// packages/group/show/ReadinessPanel.tsx
//
// The board "Ready to start" surface (b222) — the INTERACTIVE twin of `nextActionsText` (the GTD text report):
// the dependency FRONTIER stacked as two EMBEDDED `RankedJumpList` sections under one header + Close —
// "Ready to start" (cards actionable right now: not done, nothing gating them) and "Blocked" (each waiting card
// + the cards it is waiting on, by human label). Both read the SAME `board-readiness` verdict (the blind
// classify-readiness engine, b144); this panel only shapes rows + jumps. Answers "what can I do RIGHT NOW?" —
// distinct from Critical path (one longest chain) and Agenda (date order). ui only (L065).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Button, Card, Container, Text } from '../../ui';
import { RankedJumpList, type RankedRow } from './RankedJumpList';
import type { CardReadiness } from '../read-data/board-readiness';

export interface ReadinessPanelProps {
  /** Every content card's readiness verdict (done / ready / blocked + blockers) from `boardReadiness`. */
  readonly readiness: readonly CardReadiness[];
  /** Resolve a card id to its human label (the blocker ids are shown by label, not id). */
  readonly labelOf: (id: string) => string;
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
}

export function ReadinessPanel({ readiness, labelOf, onJumpTo, onClose }: ReadinessPanelProps): JSX.Element {
  const noop = () => {};
  const readyRows: RankedRow[] = readiness
    .filter((r) => r.status === 'ready')
    .map((r) => ({ id: r.cardId, label: labelOf(r.cardId) }));
  const blockedRows: RankedRow[] = readiness
    .filter((r) => r.status === 'blocked')
    .map((r) => ({ id: r.cardId, label: labelOf(r.cardId), note: `waiting on: ${r.blockedBy.map(labelOf).join(', ')}` }));
  return (
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="md" style={{ minWidth: 280, maxWidth: 340 }}>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-md" weight="semibold">Ready to start</Text>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close ready-to-start panel">Close</Button>
        </Container>

        <RankedJumpList
          embedded
          title="Ready now"
          subtitle={readyRows.length > 0 ? `${readyRows.length} actionable` : undefined}
          rows={readyRows}
          emptyText="Nothing is actionable right now — every unfinished card is waiting on a prerequisite."
          onJumpTo={onJumpTo}
          onClose={noop}
        />

        <RankedJumpList
          embedded
          title="Blocked"
          subtitle={blockedRows.length > 0 ? `${blockedRows.length} waiting` : undefined}
          rows={blockedRows}
          emptyText="Nothing is blocked — no card is waiting on an unfinished prerequisite."
          onJumpTo={onJumpTo}
          onClose={noop}
        />
      </Container>
    </Card>
  );
}
