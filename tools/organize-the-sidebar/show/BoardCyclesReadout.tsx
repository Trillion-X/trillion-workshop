// packages/group/show/BoardCyclesReadout.tsx
//
// BOARD CYCLES READOUT — the surface for the `board-cycles` leaf (b128). A circular dependency is a DEFECT: a
// ring of cards that each wait on another in the ring, so nothing in it can start. This panel WARNS about each
// tangle and lets the user jump straight to it. It sits under the Hubs / Islands panels (all connector-graph
// views) and is only rendered when there IS a cycle — a clean acyclic board shows nothing here, so it is never
// filler (L118). Clicking a tangle selects all the cards caught in the loop.
//
// `ui`-only chrome (Container/Text — L065-safe). BLIND to what a card is (L090) — it renders whatever
// `connectorCycles` returns, so a new tangle appears with zero readout code.

import React from 'react';
import { Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { connectorCycles, type CardCycle } from '../do-work/board-cycles';
import { cardLabel } from './BoardOutlineReadout';

/** The board's circular-dependency tangles. */
export function boardCycles(items: readonly BoardItem[]): CardCycle[] {
  return connectorCycles(items);
}

export interface BoardCyclesReadoutProps {
  readonly items: readonly BoardItem[];
  /** Select all cards caught in a tangle (jump-to). */
  readonly onPickCycle?: (memberIds: readonly string[]) => void;
  /** Max tangles to list (default 8). */
  readonly maxCycles?: number;
}

/** The circular-dependency warning — a header + a row per tangle (the ring of cards + its size). */
export function BoardCyclesReadout({ items, onPickCycle, maxCycles = 8 }: BoardCyclesReadoutProps) {
  const cycles = boardCycles(items);
  const byId = React.useMemo(() => new Map(items.map((i) => [i.memberId, i])), [items]);
  // No cycle → nothing to warn about. Self-hide so the panel never appears on a clean board.
  if (cycles.length === 0) return null;

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#fff7ed', borderRadius: 12, border: '1px solid #fed7aa', minWidth: 240 }} data-board-cycles>
      <Container style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Text variant="body" style={{ fontWeight: 700, color: '#9a3412' }}>Circular dependencies</Text>
        <Text variant="body-xs" style={{ color: '#c2410c' }}>{cycles.length}</Text>
      </Container>
      <Container layout="vertical" gap="xs">
        {cycles.slice(0, maxCycles).map((c) => {
          // A short preview of the ring: the first couple of card labels, then "…" if longer.
          const labels = c.memberIds.map((id) => cardLabel(byId.get(id)));
          const preview = c.isSelfLoop
            ? `${labels[0]} → itself`
            : labels.slice(0, 2).join(' → ') + (labels.length > 2 ? ' → …' : '') + ' → ' + labels[0];
          return (
            <Container
              key={c.memberIds[0]}
              role="button"
              onClick={onPickCycle ? () => onPickCycle(c.memberIds) : undefined}
              data-cycle={c.memberIds[0]}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 8, background: '#ffedd5', cursor: onPickCycle ? 'pointer' : 'default' }}
            >
              <Text variant="body-sm" style={{ color: '#7c2d12' }}>{preview}</Text>
              <Container style={{ background: '#ffffff', border: '1px solid #fed7aa', borderRadius: 999, padding: '0 8px', minWidth: 22, textAlign: 'center' }}>
                <Text variant="body-xs" style={{ color: '#c2410c' }}>{c.size}</Text>
              </Container>
            </Container>
          );
        })}
      </Container>
    </Container>
  );
}
