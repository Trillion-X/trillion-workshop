// packages/group/show/BoardSizeRhythmReadout.tsx
//
// BOARD SIZE-RHYTHM READOUT — the surface for the `attribute-consistency` leaf (b124). It sits under the Balance
// panel (composition = WHERE cards sit + whether they SHARE a size rhythm) and shows how consistent the card
// sizes are: an overall band (green→amber→red) + a gauge per size attribute (area / width / height / aspect).
//
// `ui`-only chrome (Container/Text — L065-safe). Connectors AND section frames are excluded (edges + containers
// are not cards). BLIND to what a measure means (L090) — a new size attribute row appears with zero readout code.

import React from 'react';
import { Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import {
  analyzeRhythm,
  rhythmBand,
  SIZE_MEASURES,
  type RhythmReport,
  type SizeMeasureDef,
} from '../do-work/attribute-consistency';

/** Run the rhythm analysis over the board's cards (connectors + section frames excluded). */
export function boardRhythm(items: readonly BoardItem[], measures: readonly SizeMeasureDef[] = SIZE_MEASURES): RhythmReport {
  const rects = items
    .filter((i) => !itemIsConnector(i) && !i.isSection)
    .map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
  return analyzeRhythm(rects, measures);
}

export interface BoardSizeRhythmReadoutProps {
  readonly items: readonly BoardItem[];
  readonly measures?: readonly SizeMeasureDef[];
}

/** The size-rhythm panel — overall band + a per-attribute consistency gauge. */
export function BoardSizeRhythmReadout({ items, measures = SIZE_MEASURES }: BoardSizeRhythmReadoutProps) {
  const report = boardRhythm(items, measures);
  const pct = Math.round(report.overall * 100);
  const band = rhythmBand(report.overall);

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 240 }} data-size-rhythm>
      <Container style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Text variant="body-sm" style={{ fontWeight: 700, color: '#0f172a' }}>Card sizes</Text>
        <Container style={{ background: band.color, borderRadius: 999, padding: '3px 10px' }}>
          <Text variant="body-xs" style={{ color: band.ink, fontWeight: 700 }} data-rhythm-score>{pct}%</Text>
        </Container>
        <Text variant="body-xs" style={{ color: band.ink, fontWeight: 600 }}>{band.label}</Text>
      </Container>
      <Container layout="vertical" gap="xs">
        {report.measures.map((m) => (
          <Container key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-rhythm-measure={m.id}>
            <Text variant="body-xs" color="muted" style={{ width: 60 }}>{m.label}</Text>
            <Container style={{ position: 'relative', flex: 1, height: 6, background: '#f1f5f9', borderRadius: 999 }}>
              <Container style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round(m.consistency * 100)}%`, background: rhythmBand(m.consistency).ink, borderRadius: 999 }} />
            </Container>
            <Text variant="body-xs" color="muted" style={{ width: 30, textAlign: 'right' }}>{Math.round(m.consistency * 100)}%</Text>
          </Container>
        ))}
      </Container>
    </Container>
  );
}
