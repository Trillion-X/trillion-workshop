// packages/group/show/insight-lenses.tsx
//
// BOARD INSIGHT LENSES — the registry + picker that turns the board's analysis OVERLAYS into ONE switchable
// product surface. Each of b107–b112's overlays (cluster hulls by tag/kind/spatial/content, density heatmap,
// squarified treemap) is a *configuration* of ONE shape: an "insight lens" = a preconfigured renderer
// `(items, bounds) → SVG <g>`. So the whole family is a DATA catalog (`INSIGHT_LENSES`) dispatched through a
// blind layer + picker (L069 injected-capability-map, the same pattern as `ARRANGE_STRATEGIES`/`GRAPH_LAYOUTS`):
// adding a lens (or a new variant of one) is ONE row, zero layer/picker code (L090). The picker is the REAL
// menu the user opens; the layer draws whatever lens is active over the board.
//
// This is the product surface for b107–b112: instead of six disconnected overlays each needing its own wire,
// one lens picker + one lens layer expose them all. `ui`-only chrome (Container/Text, L065-safe); the lens
// bodies are pure SVG.

import React from 'react';
import { Container, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import type { TreemapBounds } from '../do-work/treemap';
import { ClusterHullOverlay, clusterFacetById } from './ClusterHullOverlay';
import { spatialClusterFacet } from './spatial-cluster-facet';
import { contentSimilarFacet } from './content-similar-facet';
import { DensityHeatmapOverlay, densityWeightById, densityRampById } from './DensityHeatmapOverlay';
import { TreemapOverlay, treemapValueById } from './TreemapOverlay';
import { labelColor } from 'trillion-workshop/tools/organize-the-sidebar/do-work/label-color.ts';

export interface InsightLensContext {
  readonly items: readonly BoardItem[];
  /** The board content extent (world space) — treemap fills it; overlays that don't need it ignore it. */
  readonly bounds: TreemapBounds;
}

/** One selectable board insight — DATA. `render` returns an SVG `<g>` the layer drops over the board. */
export interface InsightLens {
  readonly id: string;
  readonly label: string;
  /** Grouping heading in the picker. */
  readonly group: string;
  readonly render: (ctx: InsightLensContext) => React.ReactNode;
}

/** The content extent of the drawable items (world space), padded; a unit box when empty. */
export function boardContentBounds(items: readonly BoardItem[], pad = 16): TreemapBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const i of items) {
    if (itemIsConnector(i)) continue;
    any = true;
    minX = Math.min(minX, i.x);
    minY = Math.min(minY, i.y);
    maxX = Math.max(maxX, i.x + i.w);
    maxY = Math.max(maxY, i.y + i.h);
  }
  if (!any) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

// ── The lens catalog — each row a preconfigured overlay (DATA; a new lens is one row, L090) ──

export const INSIGHT_LENSES: readonly InsightLens[] = [
  {
    id: 'clusters-tag',
    label: 'Clusters by tag',
    group: 'Clusters',
    render: ({ items }) => <ClusterHullOverlay items={items} facet={clusterFacetById('tag')} />,
  },
  {
    id: 'clusters-kind',
    label: 'Clusters by type',
    group: 'Clusters',
    render: ({ items }) => <ClusterHullOverlay items={items} facet={clusterFacetById('kind')} />,
  },
  {
    id: 'clusters-spatial',
    label: 'Discovered piles',
    group: 'Clusters',
    render: ({ items }) => <ClusterHullOverlay items={items} facet={spatialClusterFacet(items).facet} />,
  },
  {
    id: 'duplicates',
    label: 'Similar notes',
    group: 'Clusters',
    render: ({ items }) => <ClusterHullOverlay items={items} facet={contentSimilarFacet(items).facet} />,
  },
  {
    id: 'heatmap-density',
    label: 'Density heatmap',
    group: 'Density',
    render: ({ items }) => (
      <DensityHeatmapOverlay items={items} weight={densityWeightById('count')} ramp={densityRampById('heat')} />
    ),
  },
  {
    id: 'heatmap-progress',
    label: 'Progress heatmap',
    group: 'Density',
    render: ({ items }) => (
      <DensityHeatmapOverlay items={items} weight={densityWeightById('progress')} ramp={densityRampById('indigo')} />
    ),
  },
  {
    id: 'treemap-votes',
    label: 'Treemap by votes',
    group: 'Proportion',
    render: ({ items, bounds }) => <TreemapOverlay items={items} value={treemapValueById('votes')} bounds={bounds} />,
  },
];

export function lensById(id: string | undefined): InsightLens | undefined {
  return INSIGHT_LENSES.find((l) => l.id === id);
}

/** Lens rows grouped by their `group` heading, preserving catalog order. */
export function lensesByGroup(): { group: string; lenses: InsightLens[] }[] {
  const groups: { group: string; lenses: InsightLens[] }[] = [];
  for (const lens of INSIGHT_LENSES) {
    let g = groups.find((x) => x.group === lens.group);
    if (!g) {
      g = { group: lens.group, lenses: [] };
      groups.push(g);
    }
    g.lenses.push(lens);
  }
  return groups;
}

export interface InsightLensLayerProps {
  readonly items: readonly BoardItem[];
  readonly lensId: string | undefined;
  /** Board content bounds (defaults to the items' extent). */
  readonly bounds?: TreemapBounds;
}

/** The blind layer — renders the active lens's `<g>` (nothing when no/unknown lens). Wrap in the board `<svg>`. */
export function InsightLensLayer({ items, lensId, bounds }: InsightLensLayerProps) {
  const lens = lensById(lensId);
  if (!lens) return null;
  return <g data-insight-lens={lens.id}>{lens.render({ items, bounds: bounds ?? boardContentBounds(items) })}</g>;
}

/** The world-space SVG wrapper for the lens layer — mirrors `ConnectorLayer`'s 1×1 `overflow:visible`
 *  absolute svg so the lens `<g>` (world-coordinate geometry) aligns exactly with the board's node rects when
 *  dropped inside `CanvasWorldTransform`. `pointerEvents:none` so the insight wash never intercepts board
 *  interaction. Renders nothing when no lens is active. This is the ONE piece a board panel mounts. */
export function InsightLensSvg({ items, lensId, bounds }: InsightLensLayerProps) {
  if (!lensById(lensId)) return null;
  return (
    <svg
      aria-hidden
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
    >
      <InsightLensLayer items={items} lensId={lensId} bounds={bounds} />
    </svg>
  );
}

export interface InsightLensPickerProps {
  readonly activeId: string | undefined;
  readonly onPick: (id: string | undefined) => void;
}

/** The lens menu — grouped chips; clicking the active one clears it (toggle off). Blind to lens meaning. */
export function InsightLensPicker({ activeId, onPick }: InsightLensPickerProps) {
  return (
    <Container layout="vertical" gap="sm" data-insight-lens-picker>
      {lensesByGroup().map((g) => (
        <Container key={g.group} layout="vertical" gap="xs">
          <Text variant="body-xs" color="muted">{g.group}</Text>
          <Container style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {g.lenses.map((lens) => {
              const active = lens.id === activeId;
              const c = labelColor(lens.label);
              return (
                <Container
                  key={lens.id}
                  onClick={() => onPick(active ? undefined : lens.id)}
                  aria-pressed={active}
                  role="button"
                  style={{
                    background: active ? c.bg : 'transparent',
                    border: `1px solid ${active ? c.fg : '#cbd5e1'}`,
                    borderRadius: 999,
                    padding: '3px 12px',
                    cursor: 'pointer',
                  }}
                >
                  <Text variant="body-sm" style={{ color: active ? c.fg : '#475569', fontWeight: active ? 600 : 400 }}>
                    {lens.label}
                  </Text>
                </Container>
              );
            })}
          </Container>
        </Container>
      ))}
    </Container>
  );
}
