// packages/group/show/AgendaPanel.tsx
//
// The AGENDA panel — the board's "what's coming up" view: dated cards grouped by URGENCY (Overdue / Today / Due
// soon / Upcoming / Later), each a jump-to list nearest-due first. The multi-section sibling of DueSoonPanel (one
// flat list) — same shape as ReviewPanel, which stacks lens sections: one embedded RankedJumpList per urgency
// bucket, each row carrying the countdown badge ("in 5 days" / "3 days ago"). BLIND (L090) over the
// `boardAgenda` groups — it names no bucket beyond what the leaf returns (empty buckets are already dropped
// upstream, so no dead sections, L118). ui-only, stateless.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Button, Card, Container, Text } from '../../ui/index.ts';
import { RankedJumpList, type RankedRow } from './RankedJumpList.tsx';
import type { AgendaGroup } from '../read-data/board-agenda.ts';

export interface AgendaPanelProps {
  readonly groups: readonly AgendaGroup[];
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
  readonly embedded?: boolean;
}

export function AgendaPanel({ groups, onJumpTo, onClose, embedded }: AgendaPanelProps): JSX.Element {
  const noop = () => {};
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  const body = (
    <Container layout="vertical" gap="md" style={{ minWidth: 280, maxWidth: 340, maxHeight: '64vh', overflowY: 'auto' }}>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Text variant="body-md" weight="semibold">Agenda</Text>
        {total > 0 ? <Text variant="body-sm" tone="muted">{`${total} dated`}</Text> : null}
        {embedded ? null : (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close agenda panel">Close</Button>
        )}
      </Container>

      {groups.length === 0 ? (
        <Text variant="body-sm" tone="muted">No dated cards yet. Give a card a due date and it appears here, soonest first.</Text>
      ) : (
        groups.map((g) => (
          <RankedJumpList
            key={g.urgency}
            embedded
            title={g.label}
            subtitle={`${g.entries.length}`}
            rows={g.entries.map((e): RankedRow => ({ id: e.memberId, label: e.title, badge: e.label }))}
            emptyText=""
            onJumpTo={onJumpTo}
            onClose={noop}
          />
        ))
      )}
    </Container>
  );
  return embedded ? body : <Card variant="popover" padding="md">{body}</Card>;
}
