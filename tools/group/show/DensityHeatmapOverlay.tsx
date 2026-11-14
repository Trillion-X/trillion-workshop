// packages/group/show/DensityHeatmapOverlay.tsx
//
// DENSITY-HEATMAP OVERLAY — the board surface for the `density-field` primitive. It colours the board by how
// CROWDED each region is (the Miro/FigJam heatmap / coverage-map canon: "where did everyone pile their notes",
// "where's the completed work concentrated"). BLIND to what a weight means (L090): the pure `heatmapCells`
// projector takes an injected `weightOf` and never names "votes"/"progress"; the `DENSITY_WEIGHTS` catalog
// carries the actual accessors as DATA (each reusing an EXISTING item accessor), and `DENSITY_RAMPS` carries
// the colour ramps as DATA — a new weight or ramp is ONE row, zero overlay code.
//
// Rendering is pure SVG (a `<g>` of `<rect>` cells the board drops behind its nodes; L065-safe). Cell opacity
// scales with normalised density so empty/sparse regions stay faint and hot regions read strong. Connectors
// are excluded (edges have no meaningful footprint weight).

import React from 'react';
import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { cardProgressView } from 'trillion-workshop/tools/organize-the-sidebar/read-data/card-progress-view.ts';
import {
  densityField,
  normalizedCells,
  hotspot,
  rampColor,
  type DensityRect,
  type DensityRamp,
  type DensityBounds,
} from '../do-work/density-field';

/** One rendered heatmap cell — DATA the overlay draws blindly. */
export interface HeatmapCell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Normalised density 0..1. */
  readonly t: number;
  readonly color: string;
}

/** A selectable weighting — DATA (the accessor is injected; the overlay never enumerates weights). */
export interface DensityWeight {
  readonly id: string;
  readonly label: string;
  readonly weightOf: (item: BoardItem) => number;
}

export interface HeatmapOptions {
  readonly weightOf?: (item: BoardItem) => number;
  readonly cellSize?: number;
  readonly ramp: DensityRamp;
  readonly bounds?: DensityBounds;
  /** Skip cells below this normalised density (default 0.04 → drop near-empty noise). */
  readonly floor?: number;
  readonly rectOf?: (item: BoardItem) => DensityRect;
}

const defaultRect = (i: BoardItem): DensityRect => ({ x: i.x, y: i.y, w: i.w, h: i.h });

/**
 * Pure projector: board items + an injected weight → the coloured cells to render. Connectors are excluded.
 * Returns only cells above `floor` (sparse noise dropped). Deterministic.
 */
export function heatmapCells(items: readonly BoardItem[], opts: HeatmapOptions): HeatmapCell[] {
  const { weightOf, cellSize, ramp, bounds, floor = 0.04, rectOf = defaultRect } = opts;
  const rects: DensityRect[] = [];
  const kept: BoardItem[] = [];
  for (const item of items) {
    if (itemIsConnector(item)) continue;
    kept.push(item);
    rects.push(rectOf(item));
  }
  if (rects.length === 0) return [];
  const field = densityField(rects, { cellSize, bounds, weightOf: weightOf ? (_r, i) => weightOf(kept[i]) : undefined });
  const norm = normalizedCells(field);
  const out: HeatmapCell[] = [];
  for (let i = 0; i < norm.length; i++) {
    const t = norm[i];
    if (t < floor) continue;
    const col = i % field.cols;
    const row = Math.floor(i / field.cols);
    out.push({
      x: field.origin.x + col * field.cellSize,
      y: field.origin.y + row * field.cellSize,
      w: field.cellSize,
      h: field.cellSize,
      t,
      color: rampColor(t, ramp),
    });
  }
  return out;
}

/** The hottest region's world centre + value (for a "jump to the busiest area" affordance), or null. */
export function heatmapHotspot(items: readonly BoardItem[], opts: Pick<HeatmapOptions, 'weightOf' | 'cellSize' | 'rectOf' | 'bounds'>) {
  const rects: DensityRect[] = [];
  const kept: BoardItem[] = [];
  for (const item of items) {
    if (itemIsConnector(item)) continue;
    kept.push(item);
    rects.push((opts.rectOf ?? defaultRect)(item));
  }
  if (rects.length === 0) return null;
  const field = densityField(rects, {
    cellSize: opts.cellSize,
    bounds: opts.bounds,
    weightOf: opts.weightOf ? (_r, i) => opts.weightOf!(kept[i]) : undefined,
  });
  return hotspot(field);
}

export interface DensityHeatmapOverlayProps {
  readonly items: readonly BoardItem[];
  readonly weight: DensityWeight;
  readonly ramp: DensityRamp;
  readonly cellSize?: number;
  readonly floor?: number;
  readonly rectOf?: (item: BoardItem) => DensityRect;
  /** Peak cell opacity (default 0.7 — a wash, item content stays readable). */
  readonly maxOpacity?: number;
}

/** The overlay `<g>` — one translucent cell per hot region. Drop behind the node layer. Blind to weight meaning. */
export function DensityHeatmapOverlay({
  items,
  weight,
  ramp,
  cellSize,
  floor,
  rectOf,
  maxOpacity = 0.7,
}: DensityHeatmapOverlayProps) {
  const cells = heatmapCells(items, { weightOf: weight.weightOf, cellSize, ramp, floor, rectOf });
  return (
    <g data-density-weight={weight.id} aria-hidden="true">
      {cells.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} fill={c.color} fillOpacity={Math.min(maxOpacity, c.t * maxOpacity)} />
      ))}
    </g>
  );
}

// ── DATA catalogs (a weighting / a ramp is one row — L090) ──

/** A numeric-field weight factory — the OPEN case: any `extra.<key>` read as a number. A field weight is DATA. */
export function numericFieldWeight(key: string): (item: BoardItem) => number {
  return (item) => {
    const v = item.extra?.[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  };
}

export const DENSITY_WEIGHTS: readonly DensityWeight[] = [
  { id: 'count', label: 'Heatmap by density', weightOf: () => 1 },
  { id: 'progress', label: 'Heatmap by progress', weightOf: (i) => (cardProgressView(i)?.percent ?? 0) / 100 },
  { id: 'votes', label: 'Heatmap by votes', weightOf: numericFieldWeight('votes') },
];

export function densityWeightById(id: string | undefined): DensityWeight {
  return DENSITY_WEIGHTS.find((w) => w.id === id) ?? DENSITY_WEIGHTS[0];
}

export const DENSITY_RAMPS: Readonly<Record<string, DensityRamp>> = {
  // classic cool→warm heat (jet-lite): blue → cyan → green → yellow → red
  heat: [
    { at: 0, color: [59, 130, 246] },
    { at: 0.35, color: [16, 185, 129] },
    { at: 0.65, color: [234, 179, 8] },
    { at: 1, color: [239, 68, 68] },
  ],
  // single-hue amber wash (subtle, print-friendly)
  amber: [
    { at: 0, color: [254, 243, 199] },
    { at: 1, color: [217, 119, 6] },
  ],
  // cool mono (light → deep indigo)
  indigo: [
    { at: 0, color: [224, 231, 255] },
    { at: 1, color: [67, 56, 202] },
  ],
};

export function densityRampById(id: string | undefined): DensityRamp {
  return DENSITY_RAMPS[id ?? 'heat'] ?? DENSITY_RAMPS.heat;
}
