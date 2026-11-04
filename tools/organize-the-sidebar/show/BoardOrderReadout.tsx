// packages/group/show/BoardOrderReadout.tsx
//
// BOARD ORDER READOUT — the surface for the `board-order` leaf (b129). It turns a dependency board into a plan:
// each WAVE is a set of cards that can be worked on at the same time, and the waves run top to bottom. It sits
// under the Hubs / Islands / Cycles panels (all connector-graph views) and is only rendered when there IS an
// orderable structure (at least one wave) — a board with no connectors shows nothing here (never filler, L118).
// Clicking a wave selects all its cards. If some cards are stuck in a cycle, a muted line points at them (the
// Circular-dependencies panel names them — not duplicated here).
//
// `ui`-only chrome (Container/Text — L065-safe). BLIND to what a card is (L090) — it renders whatever
// `executionOrder` returns, so a new wave appears with zero readout code.

import React from 'react';
import { Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { executionOrder, type ExecutionOrder } from '../do-work/board-order';
import { cardLabel } from './BoardOutlineReadout';

/** The board's execution plan (waves + blocked). */
export function boardOrder(items: readonly BoardItem[]): ExecutionOrder {
  return executionOrder(items);
}

export interface BoardOrderReadoutProps {
  readonly items: readonly BoardItem[];
  /** Select all cards in a wave (they can be done together). */
  readonly onPickWave?: (memberIds: readonly string[]) => void;
  /** Max waves to list (default 12). */
  readonly maxWaves?: number;
}

/** The execution plan — a header (waves + peak parallelism) + a row per wave, and a blocked-by-cycle note. */
export function BoardOrderReadout({ items, onPickWave, maxWaves = 12 }: BoardOrderReadoutProps) {
  const order = boardOrder(items);
  const byId = React.useMemo(() => new Map(items.map((i) => [i.memberId, i])), [items]);
  // No orderable structure (no connectors, or the whole board is one cycle) → nothing to plan. Self-hide.
  if (order.waves.length === 0) return null;

  const peak = order.waves.reduce((m, w) => Math.max(m, w.memberIds.length), 0);

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 240 }} data-board-order>
      <Container style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Text variant="body" style={{ fontWeight: 700, color: '#0f172a' }}>Do-order</Text>
        <Text variant="body-xs" color="muted">{order.waves.length} steps · up to {peak} at once</Text>
      </Container>
      <Container layout="vertical" gap="xs">
        {order.waves.slice(0, maxWaves).map((w) => {
          const labels = w.memberIds.map((id) => cardLabel(byId.get(id)));
          const preview = labels.slice(0, 3).join(', ') + (labels.length > 3 ? `, +${labels.length - 3}` : '');
          return (
            <Container
              key={w.index}
              role="button"
              onClick={onPickWave ? () => onPickWave(w.memberIds) : undefined}
              data-wave={w.index}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 8, background: '#f1f5f9', cursor: onPickWave ? 'pointer' : 'default' }}
            >
              <Text variant="body-sm" style={{ color: '#334155' }}>{w.index + 1}. {preview}</Text>
              <Container style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 999, padding: '0 8px', minWidth: 22, textAlign: 'center' }}>
                <Text variant="body-xs" color="muted">{w.memberIds.length}</Text>
              </Container>
            </Container>
          );
        })}
      </Container>
      {order.blocked.length > 0 ? (
        <Text variant="body-xs" style={{ color: '#c2410c' }}>{order.blocked.length} card{order.blocked.length === 1 ? '' : 's'} blocked by a cycle</Text>
      ) : null}
    </Container>
  );
}
