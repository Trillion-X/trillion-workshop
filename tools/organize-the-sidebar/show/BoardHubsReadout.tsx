// packages/group/show/BoardHubsReadout.tsx
//
// BOARD HUBS READOUT — the surface for the `board-hubs` leaf (b126): the most-connected cards on a mind-map /
// dependency board. It ranks cards by connector centrality (degree / influence / authority — a DATA measure)
// and lists them by label with a connection count; clicking one selects + jumps to it. Shown only when the
// board actually has connectors (the caller gates the dock on `boardHasConnectors`), so it is never filler.
//
// `ui`-only chrome (Container/Text — L065-safe). BLIND to what a card is (L090) — it renders whatever `rankHubs`
// returns, so a new centrality measure or a new card appears with zero readout code.

import React from 'react';
import { Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { rankHubs, centralityById, CENTRALITY_MEASURES, type HubNode, type CentralityMeasureDef } from '../do-work/board-hubs';
import { cardLabel } from './BoardOutlineReadout';

/** Rank the board's hub cards. */
export function boardHubs(items: readonly BoardItem[], measure?: string, measures: readonly CentralityMeasureDef[] = CENTRALITY_MEASURES): HubNode[] {
  return rankHubs(items, { measure, measures });
}

export interface BoardHubsReadoutProps {
  readonly items: readonly BoardItem[];
  readonly measure?: string;
  /** Select the hub card (jump-to). */
  readonly onPickHub?: (memberId: string) => void;
  /** Max hub rows (default 10). */
  readonly maxHubs?: number;
}

/** The hubs panel — a "Most connected" header + a ranked list of hub cards (label + connection count). */
export function BoardHubsReadout({ items, measure, onPickHub, maxHubs = 10 }: BoardHubsReadoutProps) {
  const hubs = boardHubs(items, measure).slice(0, maxHubs);
  const byId = React.useMemo(() => new Map(items.map((i) => [i.memberId, i])), [items]);
  const measureLabel = centralityById(measure).label;

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 240 }} data-board-hubs>
      <Container style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Text variant="body" style={{ fontWeight: 700, color: '#0f172a' }}>Hubs</Text>
        <Text variant="body-xs" color="muted">{measureLabel.toLowerCase()}</Text>
      </Container>

      {hubs.length === 0 ? (
        <Text variant="body-xs" color="muted">No connected cards yet — link cards with connectors to see the board's hubs.</Text>
      ) : (
        <Container layout="vertical" gap="xs">
          {hubs.map((h) => (
            <Container
              key={h.memberId}
              role="button"
              onClick={onPickHub ? () => onPickHub(h.memberId) : undefined}
              data-hub={h.memberId}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 8, background: '#f1f5f9', cursor: onPickHub ? 'pointer' : 'default' }}
            >
              <Text variant="body-sm" style={{ color: '#334155', fontWeight: 600 }}>{cardLabel(byId.get(h.memberId))}</Text>
              <Container style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Text variant="body-xs" color="muted">→{h.outDegree} ←{h.inDegree}</Text>
                <Container style={{ background: '#4338ca', borderRadius: 999, padding: '0 8px', minWidth: 22, textAlign: 'center' }}>
                  <Text variant="body-xs" style={{ color: '#ffffff', fontWeight: 700 }}>{h.score}</Text>
                </Container>
              </Container>
            </Container>
          ))}
        </Container>
      )}
    </Container>
  );
}
