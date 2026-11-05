// packages/group/show/BoardComponentsReadout.tsx
//
// BOARD COMPONENTS READOUT — the surface for the `board-components` leaf (b127). It sits under the Hubs panel
// (both are connector-graph views) and shows the board's ISLANDS: the separate connected clusters the
// connectors split into. Only rendered when there is more than one island (a single connected board has nothing
// to say here) — so it never adds noise. Clicking an island selects all its cards.
//
// `ui`-only chrome (Container/Text — L065-safe). BLIND to what a card is (L090) — it renders whatever
// `connectorComponents` returns, so a new island appears with zero readout code.

import React from 'react';
import { Container, Text } from '../../ui/index.ts';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { connectorComponents, type ConnectorComponent } from '../do-work/board-components.ts';
import { cardLabel } from './BoardOutlineReadout.tsx';

/** The board's connector islands. */
export function boardComponents(items: readonly BoardItem[]): ConnectorComponent[] {
  return connectorComponents(items);
}

export interface BoardComponentsReadoutProps {
  readonly items: readonly BoardItem[];
  /** Select all cards in an island (jump-to). */
  readonly onPickComponent?: (memberIds: readonly string[]) => void;
  /** Max islands to list (default 12). */
  readonly maxComponents?: number;
}

/** The islands panel — a "N separate groups" header + a row per island (size + a preview label). */
export function BoardComponentsReadout({ items, onPickComponent, maxComponents = 12 }: BoardComponentsReadoutProps) {
  const comps = boardComponents(items);
  const byId = React.useMemo(() => new Map(items.map((i) => [i.memberId, i])), [items]);
  // A single (or zero) island is not worth a panel — the caller can skip mounting, but guard here too.
  if (comps.length < 2) return null;

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 240 }} data-board-components>
      <Container style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Text variant="body" style={{ fontWeight: 700, color: '#0f172a' }}>Separate groups</Text>
        <Text variant="body-xs" color="muted">{comps.length} islands</Text>
      </Container>
      <Container layout="vertical" gap="xs">
        {comps.slice(0, maxComponents).map((c, i) => (
          <Container
            key={c.memberIds[0]}
            role="button"
            onClick={onPickComponent ? () => onPickComponent(c.memberIds) : undefined}
            data-component={c.memberIds[0]}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 8, background: '#f1f5f9', cursor: onPickComponent ? 'pointer' : 'default' }}
          >
            <Text variant="body-sm" style={{ color: '#334155' }}>Group {i + 1} · {cardLabel(byId.get(c.memberIds[0]))}</Text>
            <Container style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 999, padding: '0 8px', minWidth: 22, textAlign: 'center' }}>
              <Text variant="body-xs" color="muted">{c.size}</Text>
            </Container>
          </Container>
        ))}
      </Container>
    </Container>
  );
}
