// packages/group/show/BoardBottlenecksReadout.tsx
//
// BOARD BOTTLENECKS READOUT — the surface for the `board-bottlenecks` leaf (b130). It shows the LOAD-BEARING
// cards: the ones holding the plan together, so that removing one would split the board into disconnected
// pieces (the graph's articulation points). It sits under the Hubs / Islands / Cycles / Order panels (all
// connector-graph views) and is only rendered when there IS a bottleneck — a board with redundant paths shows
// nothing here (never filler, L118). Clicking a card jumps to it.
//
// `ui`-only chrome (Container/Text — L065-safe). BLIND to what a card is (L090) — it renders whatever
// `articulationCards` returns, so a new bottleneck appears with zero readout code.

import React from 'react';
import { Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { articulationCards, type ArticulationCard } from '../do-work/board-bottlenecks';
import { cardLabel } from './BoardOutlineReadout';

/** The board's load-bearing cards. */
export function boardBottlenecks(items: readonly BoardItem[]): ArticulationCard[] {
  return articulationCards(items);
}

export interface BoardBottlenecksReadoutProps {
  readonly items: readonly BoardItem[];
  /** Jump to a load-bearing card. */
  readonly onPickBottleneck?: (memberId: string) => void;
  /** Max cards to list (default 10). */
  readonly maxBottlenecks?: number;
}

/** The load-bearing-cards panel — a header + a row per bottleneck (label + how many pieces its removal splits). */
export function BoardBottlenecksReadout({ items, onPickBottleneck, maxBottlenecks = 10 }: BoardBottlenecksReadoutProps) {
  const arts = boardBottlenecks(items);
  const byId = React.useMemo(() => new Map(items.map((i) => [i.memberId, i])), [items]);
  // No articulation point → the plan has no single point of failure. Self-hide.
  if (arts.length === 0) return null;

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 240 }} data-board-bottlenecks>
      <Container style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Text variant="body" style={{ fontWeight: 700, color: '#0f172a' }}>Load-bearing cards</Text>
        <Text variant="body-xs" color="muted">{arts.length}</Text>
      </Container>
      <Container layout="vertical" gap="xs">
        {arts.slice(0, maxBottlenecks).map((a) => (
          <Container
            key={a.memberId}
            role="button"
            onClick={onPickBottleneck ? () => onPickBottleneck(a.memberId) : undefined}
            data-bottleneck={a.memberId}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 8, background: '#f1f5f9', cursor: onPickBottleneck ? 'pointer' : 'default' }}
          >
            <Text variant="body-sm" style={{ color: '#334155' }}>{cardLabel(byId.get(a.memberId))}</Text>
            <Container style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 999, padding: '0 8px' }}>
              <Text variant="body-xs" style={{ color: '#c2410c' }}>splits {a.splitInto}</Text>
            </Container>
          </Container>
        ))}
      </Container>
    </Container>
  );
}
