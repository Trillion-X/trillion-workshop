// packages/group/show/ClusterHullOverlay.tsx
//
// CLUSTER-TERRITORY OVERLAY — the board surface for the `cluster-hull` primitive. Given the board items and
// an INJECTED facet (which grouping key each item belongs to), it draws ONE soft blob behind each cluster so
// a group of related notes reads as a shared region WITHOUT a hard rectangular frame (the Kumu / InfraNodus /
// FigJam-section look). It is BLIND to what a facet means (L090): the pure `clusterHulls` projector takes a
// `keyOf` and never names "tag" / "colour" / "kind"; the `CLUSTER_FACETS` catalog below carries the actual
// accessors as DATA, each reusing the SAME `keyOf` accessors arrange-by-facet / select-similar already use, so
// a new cluster axis (by assignee, by due-week, by any `extra` field) is ONE catalog row, zero overlay code.
//
// Rendering is pure SVG (a `<g>` the board drops behind its nodes; L065-safe — no div/span/p). Colours come
// from the deterministic `labelColor` (b101) so each cluster's tint is stable + contrast-safe, matching the
// tag-chip colours a note already shows. Connectors are excluded (they are edges, not cluster members).

import React from 'react';
import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { convexHull, hullPath, rectCorners, type HullRect } from '../do-work/cluster-hull';
import { labelColor } from '../do-work/label-color';
import { itemTags } from './item-tags';
import { itemFillColor } from './item-fill';

/** One computed cluster region — DATA the overlay renders blindly. */
export interface ClusterHull {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** The SVG `d` for the blob. */
  readonly path: string;
  /** Cluster tint (fill) + ink (stroke/label), stable per key. */
  readonly fill: string;
  readonly ink: string;
  /** Where to anchor the cluster label (top-centre of the hull). */
  readonly labelAt: { x: number; y: number };
}

/** A selectable cluster axis — DATA (the accessor is injected; the overlay never enumerates facets). */
export interface ClusterFacet {
  readonly id: string;
  readonly label: string;
  /** The grouping key for an item, or undefined → the item is not in any cluster (skipped). */
  readonly keyOf: (item: BoardItem) => string | undefined;
  /** Human label for a raw key (default: the key itself). */
  readonly labelOf?: (key: string) => string;
}

export interface ClusterHullsOptions {
  readonly keyOf: (item: BoardItem) => string | undefined;
  readonly labelOf?: (key: string) => string;
  /** Blob padding off the item footprints (default 26). */
  readonly padding?: number;
  /** Corner rounding for a ≥3-vertex hull (default 20). */
  readonly radius?: number;
  /** Skip clusters smaller than this (default 1 → outline even a lone item). */
  readonly minGroup?: number;
  /** Read an item's world rect (default: its own x/y/w/h) — injected so the caller can pass camera-space. */
  readonly rectOf?: (item: BoardItem) => HullRect;
}

const defaultRect = (i: BoardItem): HullRect => ({ x: i.x, y: i.y, w: i.w, h: i.h });

/**
 * Pure projector: board items + an injected `keyOf` → one {@link ClusterHull} per group. Connectors are
 * excluded (edges, not members); an item whose key is undefined/empty joins no cluster. Deterministic — the
 * output order follows first-appearance of each key, so the render is stable across passes.
 */
export function clusterHulls(items: readonly BoardItem[], opts: ClusterHullsOptions): ClusterHull[] {
  const { keyOf, labelOf, padding = 26, radius = 20, minGroup = 1, rectOf = defaultRect } = opts;
  const order: string[] = [];
  const groups = new Map<string, BoardItem[]>();
  for (const item of items) {
    if (itemIsConnector(item)) continue;
    const key = keyOf(item);
    if (key === undefined || key === '') continue;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(item);
  }
  const out: ClusterHull[] = [];
  for (const key of order) {
    const members = groups.get(key)!;
    if (members.length < minGroup) continue;
    const hull = convexHull(members.flatMap((m) => rectCorners(rectOf(m))));
    if (hull.length === 0) continue;
    const path = hullPath(hull, padding, radius);
    if (!path) continue;
    const color = labelColor(key);
    // Anchor the label at the top-centre of the hull's bounding span.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    for (const p of hull) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
    }
    out.push({
      key,
      label: labelOf ? labelOf(key) : key,
      count: members.length,
      path,
      fill: color.bg,
      ink: color.fg,
      labelAt: { x: (minX + maxX) / 2, y: minY - padding },
    });
  }
  return out;
}

export interface ClusterHullOverlayProps {
  readonly items: readonly BoardItem[];
  readonly facet: ClusterFacet;
  readonly padding?: number;
  readonly radius?: number;
  readonly minGroup?: number;
  readonly rectOf?: (item: BoardItem) => HullRect;
  /** Blob fill opacity (default 0.3 — a wash, so item content stays readable on top). */
  readonly fillOpacity?: number;
  readonly showLabels?: boolean;
}

/**
 * The overlay `<g>` — one blob + optional label per cluster. Drop it behind the node layer inside the board's
 * world-transformed `<svg>`. Blind to facet meaning: it renders whatever {@link clusterHulls} returns.
 */
export function ClusterHullOverlay({
  items,
  facet,
  padding,
  radius,
  minGroup,
  rectOf,
  fillOpacity = 0.3,
  showLabels = true,
}: ClusterHullOverlayProps) {
  const hulls = clusterHulls(items, { keyOf: facet.keyOf, labelOf: facet.labelOf, padding, radius, minGroup, rectOf });
  return (
    <g data-cluster-facet={facet.id} aria-hidden="true">
      {hulls.map((h) => (
        <g key={h.key}>
          <path d={h.path} fill={h.fill} fillOpacity={fillOpacity} stroke={h.ink} strokeWidth={1.5} strokeOpacity={0.6} />
          {showLabels && (
            <text x={h.labelAt.x} y={h.labelAt.y} textAnchor="middle" fontSize={13} fontWeight={600} fill={h.ink}>
              {h.label} · {h.count}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}

/** The cluster axes the board offers — DATA (each reuses an existing item accessor). A new axis = one row. */
export const CLUSTER_FACETS: readonly ClusterFacet[] = [
  { id: 'tag', label: 'Outline clusters by tag', keyOf: (i) => itemTags(i)[0] },
  { id: 'kind', label: 'Outline clusters by type', keyOf: (i) => (i.kind ? i.kind : undefined) },
  { id: 'color', label: 'Outline clusters by colour', keyOf: (i) => itemFillColor(i) },
];

export function clusterFacetById(id: string | undefined): ClusterFacet {
  return CLUSTER_FACETS.find((f) => f.id === id) ?? CLUSTER_FACETS[0];
}
