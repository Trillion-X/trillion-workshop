// packages/group/show/TreemapOverlay.tsx
//
// TREEMAP OVERLAY — the board surface for the `treemap` primitive. It renders a proportion map where each
// item is a tile SIZED by an injected value (votes / progress / word-count / count / area) so the biggest tile
// is the highest-value item (the treemap canon). BLIND to what it's measuring (L090): the pure `treemapCells`
// projector takes an injected `valueOf` and never names "votes"; the `TREEMAP_VALUES` catalog carries the
// actual accessors as DATA, each REUSING an existing measure (`numericFieldWeight` from b108, `cardProgressView`,
// `contentWords` from b111) — a new value axis is one row, zero overlay code.
//
// Rendering is pure SVG (`<rect>` tiles + `<text>` labels; L065-safe), tiles coloured by the deterministic
// `labelColor` (b101) keyed on each tile's label so categories read apart. Connectors are excluded.

import React from 'react';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { cardProgressView } from '../read-data/card-progress-view.ts';
import { labelColor } from '../do-work/label-color.ts';
import { squarifiedTreemap, type TreemapBounds } from '../do-work/treemap.ts';
import { numericFieldWeight } from './DensityHeatmapOverlay.tsx';
import { contentWords } from './TagCloud.tsx';

export interface TreemapCell {
  readonly item: BoardItem;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly value: number;
  readonly label: string;
  readonly fill: string;
  readonly ink: string;
}

/** A selectable value axis — DATA (the measure is injected; the overlay never enumerates axes). */
export interface TreemapValue {
  readonly id: string;
  readonly label: string;
  readonly valueOf: (item: BoardItem) => number;
}

export interface TreemapCellsOptions {
  readonly valueOf: (item: BoardItem) => number;
  readonly bounds: TreemapBounds;
  readonly labelOf?: (item: BoardItem) => string;
}

const defaultLabel = (i: BoardItem): string => {
  const t = typeof i.text === 'string' ? i.text.trim() : '';
  return t !== '' ? t : i.kind;
};

/**
 * Pure projector: board items + an injected value → the treemap tiles (each mapped back to its item, coloured
 * by its label). Connectors excluded. Deterministic.
 */
export function treemapCells(items: readonly BoardItem[], opts: TreemapCellsOptions): TreemapCell[] {
  const labelOf = opts.labelOf ?? defaultLabel;
  const drawable = items.filter((i) => !itemIsConnector(i));
  const tiles = squarifiedTreemap(drawable.map((i) => opts.valueOf(i)), opts.bounds);
  return tiles.map((t) => {
    const item = drawable[t.index];
    const label = labelOf(item);
    const c = labelColor(label);
    return { item, x: t.x, y: t.y, w: t.w, h: t.h, value: t.value, label, fill: c.bg, ink: c.fg };
  });
}

export interface TreemapOverlayProps {
  readonly items: readonly BoardItem[];
  readonly value: TreemapValue;
  readonly bounds: TreemapBounds;
  readonly labelOf?: (item: BoardItem) => string;
  readonly onPick?: (item: BoardItem) => void;
  /** Hide labels on tiles smaller than this (px) to avoid clutter (default 34). */
  readonly minLabelSize?: number;
}

/** The treemap `<g>` — one tile + label per item. Blind to the value's meaning. */
export function TreemapOverlay({ items, value, bounds, labelOf, onPick, minLabelSize = 34 }: TreemapOverlayProps) {
  const cells = treemapCells(items, { valueOf: value.valueOf, bounds, labelOf });
  return (
    <g data-treemap-value={value.id}>
      {cells.map((c, i) => (
        <g key={i} onClick={onPick ? () => onPick(c.item) : undefined} style={{ cursor: onPick ? 'pointer' : 'default' }}>
          <rect x={c.x} y={c.y} width={c.w} height={c.h} fill={c.fill} stroke="#ffffff" strokeWidth={1.5} />
          {c.w >= minLabelSize && c.h >= minLabelSize && (
            <text x={c.x + 6} y={c.y + 18} fontSize={13} fontWeight={600} fill={c.ink} clipPath={`inset(0 0 0 0)`}>
              {c.label.length > Math.floor(c.w / 8) ? `${c.label.slice(0, Math.max(0, Math.floor(c.w / 8) - 1))}…` : c.label}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}

// ── DATA value catalog (a value axis is one row — L090; each reuses an existing measure) ──

export const TREEMAP_VALUES: readonly TreemapValue[] = [
  { id: 'count', label: 'Treemap by count', valueOf: () => 1 },
  { id: 'votes', label: 'Treemap by votes', valueOf: numericFieldWeight('votes') },
  { id: 'progress', label: 'Treemap by progress', valueOf: (i) => (cardProgressView(i)?.percent ?? 0) / 100 },
  { id: 'words', label: 'Treemap by word count', valueOf: (i) => contentWords(typeof i.text === 'string' ? i.text : '').length },
  { id: 'area', label: 'Treemap by card size', valueOf: (i) => Math.max(0, i.w) * Math.max(0, i.h) },
];

export function treemapValueById(id: string | undefined): TreemapValue {
  return TREEMAP_VALUES.find((v) => v.id === id) ?? TREEMAP_VALUES[0];
}
