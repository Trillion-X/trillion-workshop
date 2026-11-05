// packages/group/show/BoardBalanceReadout.tsx
//
// BOARD BALANCE READOUT — the surface for the `board-balance` leaf (b119). It shows the board's macro
// COMPOSITION: an overall balance score (green→amber→red), a mini-map of the four quadrants shaded by how much
// card area each holds with the centre-of-mass dot on top, and a gauge per composition metric (even / centred /
// uses-the-space). BLIND to what a metric means (L090) — it renders whatever `analyzeBalance` returns, so a new
// metric row auto-appears with zero readout code.
//
// `ui`-only chrome (Container/Text — L065-safe); the mini-map is plain SVG. Connectors AND section frames are
// excluded (edges have no footprint; a section is a container, not a composition unit).

import React from 'react';
import { Container, Text } from '../../ui/index.ts';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import {
  analyzeBalance,
  balanceBand,
  BALANCE_METRICS,
  type BalanceResult,
  type BalanceMetricDef,
} from '../do-work/board-balance.ts';

/** Run the composition analysis over the board's cards (connectors + section frames excluded). */
export function boardBalance(items: readonly BoardItem[], metrics: readonly BalanceMetricDef[] = BALANCE_METRICS): BalanceResult {
  const rects = items
    .filter((i) => !itemIsConnector(i) && !i.isSection)
    .map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
  return analyzeBalance(rects, metrics);
}

export interface BoardBalanceReadoutProps {
  readonly items: readonly BoardItem[];
  readonly metrics?: readonly BalanceMetricDef[];
}

/** The readout: overall band + a quadrant mini-map (shaded by area share, centroid dot) + per-metric gauges. */
export function BoardBalanceReadout({ items, metrics = BALANCE_METRICS }: BoardBalanceReadoutProps) {
  const report = boardBalance(items, metrics);
  const pct = Math.round(report.overall * 100);
  const band = balanceBand(report.overall);
  const [tl, tr, bl, br] = report.quadrantShares;
  const S = 120; // mini-map edge
  const half = S / 2;
  const maxShare = Math.max(tl, tr, bl, br, 0.0001);
  // Centroid position mapped into the mini-map (fall back to centre for an empty board).
  const b = report.bounds;
  const cxN = b.w > 0 ? (report.centroid.x - b.minX) / b.w : 0.5;
  const cyN = b.h > 0 ? (report.centroid.y - b.minY) / b.h : 0.5;
  const quad = (share: number, x: number, y: number) => (
    <rect x={x} y={y} width={half} height={half} fill="#6366f1" fillOpacity={0.08 + 0.55 * (share / maxShare)} stroke="#e2e8f0" strokeWidth={0.75} />
  );

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 240 }} data-board-balance>
      <Container style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Container style={{ background: band.color, borderRadius: 999, padding: '4px 12px' }}>
          <Text variant="body" style={{ color: band.ink, fontWeight: 700 }} data-balance-score>{pct}%</Text>
        </Container>
        <Text variant="body-sm" style={{ color: band.ink, fontWeight: 600 }}>{band.label}</Text>
      </Container>

      <svg width={S} height={S} style={{ display: 'block' }} data-balance-map>
        {quad(tl, 0, 0)}
        {quad(tr, half, 0)}
        {quad(bl, 0, half)}
        {quad(br, half, half)}
        <circle cx={Math.max(4, Math.min(S - 4, cxN * S))} cy={Math.max(4, Math.min(S - 4, cyN * S))} r={5} fill="#4338ca" stroke="#ffffff" strokeWidth={1.5} />
      </svg>

      <Container layout="vertical" gap="xs">
        {report.metrics.map((m) => (
          <Container key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-balance-metric={m.id}>
            <Text variant="body-xs" color="muted" style={{ width: 96 }}>{m.label}</Text>
            <Container style={{ position: 'relative', flex: 1, height: 6, background: '#f1f5f9', borderRadius: 999 }}>
              <Container style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round(m.value * 100)}%`, background: balanceBand(m.value).ink, borderRadius: 999 }} />
            </Container>
            <Text variant="body-xs" color="muted" style={{ width: 30, textAlign: 'right' }}>{Math.round(m.value * 100)}%</Text>
          </Container>
        ))}
      </Container>
    </Container>
  );
}
