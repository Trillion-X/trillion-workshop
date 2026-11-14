// packages/group/show/arrange-by-field.ts
//
// The arrange-by-field leaf — pure, zero I/O, framework-agnostic. Lays board items into
// tidy per-cluster grids, clustered by a precomputed `groupKey` string on each item. The
// caller decides WHAT the field is (tag / color / progress / anything) and precomputes the
// groupKey; this leaf is blind to that meaning and MUST NEVER enumerate any field kind
// (L090 — self-describing data, generic handler). Kept pure so the geometry is unit-tested;
// the panel holds only the React state and applies the returned positions.

import { finiteCoord } from '../read-data/finite-coord';
import { ownValue } from 'trillion-workshop/tools/organize-the-sidebar/read-data/facet-filter.ts';

/** Sanitize an untrusted item dimension (persisted w/h): a `Number.MAX_VALUE`/`Infinity`/`NaN` would
 *  otherwise accumulate into `colX += item.w` → an Infinity/NaN coordinate. `finiteCoord` bounds both
 *  non-finite and finite-huge; a dimension is floored at 0 (a negative box is never real). */
const dim = (v: number): number => Math.max(0, finiteCoord(v));
/** Sanitize an untrusted numeric OPTION (origin/gap seeds the position accumulation, so a huge one
 *  overflows every downstream coord). Clamps to a finite board coord; a caller default is a no-op. */
const optNum = (v: number | undefined, dflt: number): number => (typeof v === 'number' ? finiteCoord(v) : dflt);

export interface ArrangeItem {
  readonly memberId: string;
  readonly w: number;
  readonly h: number;
  readonly groupKey: string;
}

export interface ArrangedPosition {
  readonly memberId: string;
  readonly x: number;
  readonly y: number;
}

/** The bounding region of ONE cluster — the tight box enclosing every item placed in it,
 *  plus its raw `key` and item `count`. This is the missing half of "arrange BY a field": the
 *  positions say WHERE each item goes; the region says WHICH group that area of the board IS,
 *  so a header band / background card / count badge can be drawn per group. Geometry only —
 *  the region carries the RAW groupKey, never a human label or facet vocabulary (L090). The
 *  render boundary maps `key → label` via {@link regionLabelFor}. */
export interface ClusterRegion {
  readonly key: string; // the raw groupKey this cluster was bucketed under ('' = the no-key pile)
  readonly x: number; // top-left of the cluster's bounding box
  readonly y: number;
  readonly w: number; // width/height enclosing every placed item in the cluster
  readonly h: number;
  readonly count: number; // number of items in the cluster
}

/** The full arrange-by-field result: one position per item AND one region per cluster. The
 *  region-aware layout is the primitive; `arrangeByField` is a thin projection of `.positions`
 *  (SSOT — one geometry pass produces both, so positions and regions can never disagree). */
export interface ClusterLayout {
  readonly positions: ArrangedPosition[];
  readonly regions: ClusterRegion[];
}

export interface ArrangeByFieldOptions {
  readonly colGap?: number; // gap between items in a cluster row (default 24)
  readonly rowGap?: number; // gap between rows within a cluster (default 24)
  readonly clusterGap?: number; // vertical gap between clusters (default 64)
  readonly originX?: number; // top-left of the whole arrangement (default 0)
  readonly originY?: number; // (default 0)
  readonly maxPerRow?: number; // max items per row within a cluster (default 4)
  // LANE MODE (kanban): an explicit, ORDERED set of cluster keys. When present, clusters appear
  // in THIS order (not sorted), EVERY listed key gets a region even with zero items (an empty
  // lane — a visible drop zone / persisted column), and any item key not listed is appended
  // after, sorted (nothing is ever dropped). Also switches regions to the uniform "owned lane
  // footprint" width so all lanes align (see the region width note below). Omit → sorted mode
  // with tight per-cluster boxes (zero-regression default).
  readonly laneKeys?: readonly string[];
  // HEADER BAND: reserve this many px of empty space at the TOP of every cluster for a heading
  // label. Items in each cluster are pushed DOWN by this amount; the region box GROWS upward to
  // include the band (region.y = the band top, region.h includes it). This is how a labelled
  // group header sits ABOVE its items without overlapping them. Default 0 → items sit at the
  // cluster top exactly (zero-regression); only a positive value reserves the band.
  readonly headerReserve?: number;
}

/** The cluster ORDER, shared by every cluster layout (row-grid + column/kanban). SORTED mode
 *  (no `laneKeys`): the keys present, ascending. LANE mode (`laneKeys` given): the given keys
 *  (deduped, in order) FIRST — even ones with no items (an empty lane/column) — then any extra
 *  present keys appended, sorted. One SSOT so the two layouts order clusters identically. */
export function orderedClusterKeys(presentKeys: readonly string[], laneKeys?: readonly string[]): string[] {
  const sortAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  if (!Array.isArray(laneKeys)) return [...presentKeys].sort(sortAsc);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const k of laneKeys) {
    if (!seen.has(k)) {
      seen.add(k);
      ordered.push(k);
    }
  }
  const extra = presentKeys.filter((k) => !seen.has(k)).sort(sortAsc);
  return [...ordered, ...extra];
}

// Group `items` by `groupKey` and lay each cluster as a row-major grid, stacking the clusters
// vertically. Returns { positions, regions }: exactly one position per input item (same set of
// memberIds) and one region per cluster. Empty input → { positions: [], regions: [] }.
//
// Two modes (Codex-converged 2026-07-04):
//  • SORTED (default, no `laneKeys`): clusters = the keys PRESENT in items, sorted ascending;
//    each region is the TIGHT bounding box over that cluster's placed items. Exact, and
//    `arrangeByField` projects `.positions` byte-identically (zero regression).
//  • LANE (kanban, `laneKeys` given): clusters follow `laneKeys` order; every listed key gets a
//    region even with zero items (empty lane); unlisted item keys are appended sorted. Regions
//    take the UNIFORM "owned lane footprint" width (= the widest cluster's content width) so
//    lanes align and empty lanes are still visible. Item POSITIONS are identical to sorted mode
//    given the same order — only the region.w widens to the lane footprint (the "area the lane
//    owns", not the tight child extent — the header-band/background-card contract).
//
// Deterministic: within a cluster, item order = input order. This is the CORE — the two public
// wrappers project from it.
export function arrangeByFieldWithRegions(
  items: readonly ArrangeItem[],
  opts?: ArrangeByFieldOptions,
): ClusterLayout {
  const colGap = optNum(opts?.colGap, 24);
  const rowGap = optNum(opts?.rowGap, 24);
  const clusterGap = optNum(opts?.clusterGap, 64);
  const originX = optNum(opts?.originX, 0);
  const originY = optNum(opts?.originY, 0);
  // maxPerRow: a finite integer >= 1. `0`/NaN/negative would make `colInRow === maxPerRow` fire before
  // every item (each item on its own shifted row); an absurd value is capped so wrapping stays sane.
  const maxPerRow = Number.isFinite(opts?.maxPerRow) ? Math.max(1, Math.min(1000, Math.floor(opts!.maxPerRow!))) : 4;
  const headerReserve = typeof opts?.headerReserve === 'number' && opts.headerReserve > 0 ? finiteCoord(opts.headerReserve) : 0;
  const laneMode = Array.isArray(opts?.laneKeys);

  if (items.length === 0 && !laneMode) return { positions: [], regions: [] };

  // Bucket items by groupKey, preserving input order within each bucket.
  const buckets = new Map<string, ArrangeItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.groupKey);
    if (bucket) bucket.push(item);
    else buckets.set(item.groupKey, [item]);
  }

  const clusterKeys = orderedClusterKeys([...buckets.keys()], opts?.laneKeys);

  const positions: ArrangedPosition[] = [];
  // First pass: place items + compute each cluster's TIGHT box. In lane mode we widen the boxes
  // to the uniform lane footprint in a second pass (below).
  const boxes: { key: string; x: number; y: number; w: number; h: number; count: number }[] = [];
  let clusterTop = originY;

  for (const key of clusterKeys) {
    const clusterItems = buckets.get(key) ?? [];

    // Items start below the reserved header band; the region box still starts at clusterTop so
    // the band is inside the region, above the items.
    let rowTop = clusterTop + headerReserve;
    let colX = originX;
    let rowHeight = 0;
    let colInRow = 0;
    // Tight bounding box over this cluster's placed items (rows always start at originX, so the
    // left edge is originX; the right edge is the widest row's right, tracked as we place).
    let maxRight = originX;

    for (const item of clusterItems) {
      // Start a new row once the current row is full.
      if (colInRow === maxPerRow) {
        rowTop += rowHeight + rowGap;
        colX = originX;
        rowHeight = 0;
        colInRow = 0;
      }

      positions.push({ memberId: item.memberId, x: colX, y: rowTop });

      const iw = dim(item.w), ih = dim(item.h); // sanitize persisted geometry before it accumulates
      if (colX + iw > maxRight) maxRight = colX + iw;
      colX += iw + colGap;
      if (ih > rowHeight) rowHeight = ih;
      colInRow += 1;
    }

    // Bottom of the last (partial) row is the cluster's bottom edge. The region spans from
    // clusterTop (band top) to that bottom; an empty cluster is just the reserved band (rowTop
    // starts at clusterTop + headerReserve with rowHeight 0, so its height = headerReserve).
    const clusterBottom = rowTop + rowHeight;
    boxes.push({
      key,
      x: originX,
      y: clusterTop,
      w: maxRight - originX,
      h: clusterBottom - clusterTop,
      count: clusterItems.length,
    });

    clusterTop = clusterBottom + clusterGap;
  }

  // Lane mode: every region takes the uniform "owned footprint" width = the widest cluster's
  // content width, so lanes align and empty lanes (width 0) become visible drop zones.
  const regions: ClusterRegion[] = laneMode
    ? (() => {
        const laneWidth = boxes.reduce((m, b) => (b.w > m ? b.w : m), 0);
        return boxes.map((b) => ({ key: b.key, x: b.x, y: b.y, w: laneWidth, h: b.h, count: b.count }));
      })()
    : boxes.map((b) => ({ key: b.key, x: b.x, y: b.y, w: b.w, h: b.h, count: b.count }));

  return { positions, regions };
}

// Group `items` by `groupKey` and lay each cluster as a row-major grid, stacking the clusters
// vertically. Returns exactly one position per input item (same set of memberIds). Empty
// input → []. A thin projection of {@link arrangeByFieldWithRegions}'s positions — kept as the
// named seam every existing caller reads against (behaviour is byte-identical).
export function arrangeByField(
  items: readonly ArrangeItem[],
  opts?: ArrangeByFieldOptions,
): ArrangedPosition[] {
  return arrangeByFieldWithRegions(items, opts).positions;
}

// KANBAN / COLUMNS-BY-VALUE (§9.2 emergent). The horizontal sibling of `arrangeByFieldWithRegions`:
// where that stacks row-major clusters VERTICALLY, this lays each cluster as a SINGLE VERTICAL COLUMN
// and places the columns LEFT-TO-RIGHT — the classic status board ("To do | Doing | Done"). Same
// `ClusterLayout` shape (positions + regions), same injected `groupKey`, same `orderedClusterKeys`
// (so LANE mode gives fixed ordered columns incl. empty ones — a persisted kanban), same
// `headerReserve` band above each column, so it reuses `regionHeadingSpecs`/`regionLabelFor`
// unchanged. Columns take a UNIFORM width (= the widest item) so they align regardless of content.
// Blind to the field's meaning (L090). Empty input (no lane keys) → { positions: [], regions: [] }.
export function arrangeColumns(
  items: readonly ArrangeItem[],
  opts?: ArrangeByFieldOptions,
): ClusterLayout {
  const colGap = optNum(opts?.colGap, 24); // gap BETWEEN columns
  const rowGap = optNum(opts?.rowGap, 24); // gap between stacked items in a column
  const originX = optNum(opts?.originX, 0);
  const originY = optNum(opts?.originY, 0);
  const headerReserve = typeof opts?.headerReserve === 'number' && opts.headerReserve > 0 ? finiteCoord(opts.headerReserve) : 0;
  const laneMode = Array.isArray(opts?.laneKeys);

  if (items.length === 0 && !laneMode) return { positions: [], regions: [] };

  const buckets = new Map<string, ArrangeItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.groupKey);
    if (bucket) bucket.push(item);
    else buckets.set(item.groupKey, [item]);
  }
  const clusterKeys = orderedClusterKeys([...buckets.keys()], opts?.laneKeys);

  // Uniform column width = the widest item over the whole selection, so every column (incl. empty
  // lanes) aligns to the same footprint. 0 only in the degenerate all-empty case.
  const columnWidth = items.reduce((m, it) => { const w = dim(it.w); return w > m ? w : m; }, 0);

  const positions: ArrangedPosition[] = [];
  const regions: ClusterRegion[] = [];
  let colX = originX;
  for (const key of clusterKeys) {
    const clusterItems = buckets.get(key) ?? [];
    let y = originY + headerReserve; // items start below the header band
    for (const item of clusterItems) {
      positions.push({ memberId: item.memberId, x: colX, y }); // left-aligned in the column
      y += dim(item.h) + rowGap; // sanitize persisted height before the column accumulates
    }
    // Column bottom: after the last item we advanced by one rowGap too many; strip it. An empty
    // column is just the header band (height = headerReserve).
    const columnBottom = clusterItems.length > 0 ? y - rowGap : originY + headerReserve;
    regions.push({ key, x: colX, y: originY, w: columnWidth, h: columnBottom - originY, count: clusterItems.length });
    colX += columnWidth + colGap;
  }
  return { positions, regions };
}

/** A placeable heading for one cluster region — the label + geometry a caller drops onto the
 *  board (as a note item) or renders as an overlay band, so "arrange by field" produces LABELLED
 *  group areas, not just moved boxes. `text` is the resolved human label (optionally with the
 *  count); the box spans the region's header band (its reserved top strip). Pure DATA — carries
 *  the raw `key` too so a caller can address/replace headings idempotently. */
export interface RegionHeadingSpec {
  readonly key: string; // the raw groupKey (for stable/idempotent heading ids)
  readonly text: string; // the resolved label, e.g. "Ideas" or "Ideas · 3"
  readonly x: number; // top-left of the heading band (= region.x)
  readonly y: number; // (= region.y — the reserved band top)
  readonly w: number; // band width (= region.w, so it spans the group area)
  readonly count: number;
}

/** Project a cluster layout's `regions` into placeable {@link RegionHeadingSpec}s — one heading
 *  per region, labelled via {@link regionLabelFor} (raw key → human label from caller DATA), with
 *  an optional ` · N` count suffix. Pure, no ids, no graph: the caller mints ids and places the
 *  headings as note items OR renders them as overlay bands. Pair with `headerReserve` so the
 *  heading sits in the band above each cluster's items. */
export function regionHeadingSpecs(
  regions: readonly ClusterRegion[],
  opts?: {
    labelMap?: Record<string, string>;
    emptyLabel?: string;
    showCount?: boolean; // append " · N" (default false — label only)
  },
): RegionHeadingSpec[] {
  return regions.map((r) => {
    const label = regionLabelFor(r.key, opts?.labelMap, opts?.emptyLabel);
    return {
      key: r.key,
      text: opts?.showCount ? `${label} · ${r.count}` : label,
      x: r.x,
      y: r.y,
      w: r.w,
      count: r.count,
    };
  });
}

/** Resolve a cluster region's raw `key` to a human label at the render boundary. The geometry
 *  leaf never names a facet (L090); this maps `key → label` from caller DATA — `labelMap[key]`
 *  wins, else the key renders as-is (a tag string is already human), else the no-key pile ('')
 *  gets `emptyLabel`. `emptyLabel` defaults to 'Ungrouped' — a fact of the clustering (these
 *  items had no value for the chosen facet), not tag/color/progress vocabulary — and is
 *  overridable. Pure, never throws. */
export function regionLabelFor(
  key: string,
  labelMap?: Record<string, string>,
  emptyLabel = 'Ungrouped',
): string {
  // Own-key lookup (shared proto-safe SSOT): `key` is an untrusted facet-derived groupKey. A plain
  // `labelMap[key]` reads INHERITED members too — and a string on Object.prototype (or the caller map's
  // prototype) at that name leaks in as a false label. `ownValue` restricts to own data, so a non-own
  // key falls through to the raw key.
  const mapped = labelMap ? ownValue(labelMap, key) : undefined;
  if (typeof mapped === 'string' && mapped !== '') return mapped;
  return key !== '' ? key : emptyLabel;
}
