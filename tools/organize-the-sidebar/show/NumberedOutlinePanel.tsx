// packages/group/show/NumberedOutlinePanel.tsx
//
// The TREE OUTLINE panel — a clickable, decimal-numbered table of contents of the board's CONNECTOR tree
// (1, 1.1, 1.1.1 …), the way a spec / mind-map / agenda is numbered. DISTINCT from BoardOutlineReadout (which
// lists presentation FRAMES): this reads the connector hierarchy (`board-numbered-outline`), so a mind-map or
// spec board navigates by its own structure. A BLIND renderer (L090) of `numberedOutline(items)` — it names no
// card, folds whatever rows the leaf returns; a click jumps to that card (via the memberId the outline now
// carries — no fragile text match). ui-only, stateless. Collapses to nothing when the board has no cards (L118).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Button, Card, Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { numberedOutline } from '../read-data/board-numbered-outline';

export interface NumberedOutlinePanelProps {
  readonly items: readonly BoardItem[];
  /** Jump to a card when its outline row is clicked (rows without a memberId are inert). */
  readonly onJumpTo: (memberId: string) => void;
  readonly onClose: () => void;
  readonly embedded?: boolean;
}

export function NumberedOutlinePanel({ items, onJumpTo, onClose, embedded }: NumberedOutlinePanelProps): JSX.Element {
  const rows = numberedOutline(items);
  const body = (
    <Container layout="vertical" gap="sm" style={{ minWidth: 260, maxWidth: 340, maxHeight: '60vh', overflowY: 'auto' }}>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Text variant="body-md" weight="semibold">Tree outline</Text>
        {rows.length > 0 ? <Text variant="body-sm" tone="muted">{`${rows.length} card${rows.length === 1 ? '' : 's'}`}</Text> : null}
        {embedded ? null : (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close tree outline panel">Close</Button>
        )}
      </Container>
      {rows.length === 0 ? (
        <Text variant="body-sm" tone="muted">No cards yet. Connect cards and their hierarchy numbers here.</Text>
      ) : (
        rows.map((r, i) => (
          <Button
            key={r.memberId ?? `${r.number}-${i}`}
            variant="ghost"
            size="sm"
            onClick={() => r.memberId && onJumpTo(r.memberId)}
            aria-label={`Jump to ${r.number} ${r.text}`}
          >
            <Container layout="horizontal" gap="xs" alignItems="center" style={{ width: '100%', paddingLeft: r.depth * 16 }}>
              <Text variant="caption" tone="muted">{r.number}</Text>
              <Text variant="body-sm">{r.text || 'Untitled'}</Text>
            </Container>
          </Button>
        ))
      )}
    </Container>
  );
  return embedded ? body : <Card variant="popover" padding="md">{body}</Card>;
}
