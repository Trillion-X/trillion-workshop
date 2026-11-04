// packages/group/show/board-shapes.ts
//
// The board's catalog of geometric shapes — pure DATA. Each shape maps a human
// label + icon to a CSS `clip-path`; an item carries the chosen shape id as
// `extra.shape`, and the blind `CanvasNode` applies the resolved clip-path to its
// content (turning a rectangular item into an ellipse/diamond/…). Adding a shape is
// ONE DATA row here — zero engine/render code (L090, the #117 filter-preset pattern
// applied to geometry). The picker renders the label/icon and reports an id; it
// never knows what a shape IS. Society DATA in the feature package, not the ui engine.

import {
  shapeClipPathOf,
  shapeSvgPathOf,
  shapeOutlinePoints,
  type ShapeGeometry,
} from '../do-work/shape-geometry';
import { mergeCatalog } from '../read-data/catalog-merge';

/** One named shape: a label + lucide icon the user picks, plus its GEOMETRY (the
 *  self-describing descriptor — the SSOT). `clipPath` is DERIVED from `geometry`
 *  (kept for the live clip consumers); `geometry` also yields a bbox-FILLING SVG
 *  path for the #213 render fix and the SVG export, so live == export (one source). */
export interface BoardShape {
  /** Stable id stored in `extra.shape` (never the label — labels can change). */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  /** lucide icon name for the picker button (resolved by the blind NamedIcon). */
  icon: string;
  /** The self-describing geometry — the ONE source (clip-path, SVG path, export). */
  geometry: ShapeGeometry;
  /** The CSS `clip-path` (`''` = rectangle / no clip), DERIVED from `geometry`. */
  clipPath: string;
}

/** The published-record payload kind carrying user-defined shapes (Society DATA). */
export const SHAPE_CATALOG_KIND = 'shape-catalog';

/** The starting shape catalog as pure geometry DATA. Order = display order;
 *  `rectangle` is first/default (its `rect` geometry means "no shape" → empty
 *  clip-path, so an unset item stays a normal card). Adding a shape = ONE row —
 *  `ngon`/`star` are formulas, so a pentagon/heptagon needs zero new code. */
const BOARD_SHAPE_ROWS: ReadonlyArray<Omit<BoardShape, 'clipPath'>> = [
  { id: 'rectangle', label: 'Rectangle', icon: 'Square', geometry: { kind: 'rect' } },
  { id: 'ellipse', label: 'Ellipse', icon: 'Circle', geometry: { kind: 'ellipse' } },
  { id: 'diamond', label: 'Diamond', icon: 'Diamond', geometry: { kind: 'polygon', points: [[50, 0], [100, 50], [50, 100], [0, 50]] } },
  { id: 'triangle', label: 'Triangle', icon: 'Triangle', geometry: { kind: 'polygon', points: [[50, 0], [100, 100], [0, 100]] } },
  { id: 'hexagon', label: 'Hexagon', icon: 'Hexagon', geometry: { kind: 'polygon', points: [[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]] } },
  { id: 'star', label: 'Star', icon: 'Star', geometry: { kind: 'polygon', points: [[50, 0], [61, 35], [98, 35], [68, 57], [79, 91], [50, 70], [21, 91], [32, 57], [2, 35], [39, 35]] } },
  // Speech bubble / callout — a rectangular body (top 0–75%) with a tail dropping
  // from the lower-left to a point at 15%/100%. The canonical annotation shape;
  // one DATA row, rendered by the same blind geometry as every other shape.
  { id: 'callout', label: 'Callout', icon: 'MessageSquare', geometry: { kind: 'polygon', points: [[0, 0], [100, 0], [100, 75], [30, 75], [15, 100], [15, 75], [0, 75]] } },
];

/** The catalog — `clipPath` derived from each row's `geometry` (SSOT: change the
 *  geometry, the clip-path + SVG path + export all follow, and cannot diverge). */
export const BOARD_SHAPES: readonly BoardShape[] = BOARD_SHAPE_ROWS.map((r) => ({
  ...r,
  clipPath: shapeClipPathOf(r.geometry),
}));

/** Validate one untrusted shape DATA row. `id`, `label`, `icon`, and `geometry` are all
 *  required. A shape without geometry is meaningless. */
function shapeFromData(row: Record<string, unknown>): Omit<BoardShape, 'clipPath'> | null {
  if (
    typeof row.id === 'string' &&
    typeof row.label === 'string' &&
    typeof row.icon === 'string' &&
    row.geometry &&
    typeof row.geometry === 'object'
  ) {
    return {
      id: row.id,
      label: row.label,
      icon: row.icon,
      geometry: row.geometry as ShapeGeometry,
    };
  }
  return null;
}

/**
 * The EFFECTIVE shape catalog = the built-in {@link BOARD_SHAPES} plus any user-defined shapes
 * from `shape-catalog` published-records (Society DATA), via the generic {@link mergeCatalog}
 * primitive — so "which shapes exist" is DATA. A DATA row overrides a built-in by id, else appends.
 */
export function readShapeCatalog(
  records: ReadonlyArray<{ payload?: unknown }>,
): BoardShape[] {
  const rows = mergeCatalog(records, {
    kind: SHAPE_CATALOG_KIND,
    arrayKey: 'shapes',
    idOf: (s) => s.id,
    parseRow: shapeFromData,
    builtins: BOARD_SHAPE_ROWS,
  });
  // Derive clipPath from geometry for each row (including user-defined ones)
  return rows.map((r) => ({
    ...r,
    clipPath: shapeClipPathOf(r.geometry),
  }));
}

/** The board-DEFAULT note-shape options (label + value) for the appearance-cascade `shape` key —
 *  every catalog shape EXCEPT `rectangle` (which IS the "no shape" / cleared state, offered as the
 *  select's leading "Default"). `{value: id, label}` rows for the board-appearance `select`; derived
 *  from {@link BOARD_SHAPES} (SSOT) so a new shape row auto-appears here. Consumed by `item-appearance`
 *  BOARD_DEFAULT_CONTROLS; a board can default every note to an ellipse/diamond/hexagon (diagram/flow
 *  boards), a per-item `extra.shape` still wins, and "Default" clears → rectangle (zero-regression). */
export const SHAPE_DEFAULT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = BOARD_SHAPES
  .filter((s) => s.geometry.kind !== 'rect')
  .map((s) => ({ value: s.id, label: s.label }));

/** shape id → its readable label, derived from {@link BOARD_SHAPES} (SSOT). Used by the "Group by
 *  shape" arrangement facet so a diagram board clusters into labelled 'Ellipse' / 'Diamond' regions.
 *  A new shape row auto-appears here; the '' (rectangle / no-per-item-shape) bucket uses the facet's
 *  own `emptyLabel`. */
export const SHAPE_FACET_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  BOARD_SHAPES.map((s) => [s.id, s.label]),
);

/** Resolve a shape id → its `clip-path` string (`''` when none/unknown → rectangle). */
export function shapeClipPathById(
  id: string | undefined,
  shapes: readonly BoardShape[] = BOARD_SHAPES,
): string {
  if (!id) return '';
  return shapes.find((s) => s.id === id)?.clipPath ?? '';
}

/** Resolve a shape id → its geometry descriptor (`null` when none/unknown → the
 *  item stays a plain rectangle card, no shape path rendered). */
export function shapeGeometryById(
  id: string | undefined,
  shapes: readonly BoardShape[] = BOARD_SHAPES,
): ShapeGeometry | null {
  if (!id) return null;
  return shapes.find((s) => s.id === id)?.geometry ?? null;
}

/** Resolve a shape id → its bbox-FILLING SVG path `d` in the 0..100 percent viewBox,
 *  or `''` for none/unknown/`rect` (no shape path — the item renders as a plain
 *  card). The ONE path used by BOTH the live render (#213) and the SVG export, so
 *  a shaped item and its export can never diverge. */
export function shapeSvgPathById(
  id: string | undefined,
  shapes: readonly BoardShape[] = BOARD_SHAPES,
): string {
  const geo = shapeGeometryById(id, shapes);
  if (!geo || geo.kind === 'rect') return '';
  return shapeSvgPathOf(geo);
}

/** cont.26 — Resolve a shape id + the item's px size → its OUTLINE as an ordered closed point ring in
 *  the item's LOCAL box (0..w, 0..h), or undefined for none/unknown/`rect`. The DI resolver the SVG
 *  export injects as `shapeOutlineById` (parallel to `shapeSvgPathById`) so a shaped note with a border
 *  brushstroke EXPORTS its outline hand-drawn/dashed via the SAME `shapeOutlinePoints` leaf the live
 *  shaped-note branch uses (live == export). Keeps `board-svg` blind to the shape catalog (L090). */
export function shapeOutlineById(
  id: string | undefined,
  w: number,
  h: number,
  shapes: readonly BoardShape[] = BOARD_SHAPES,
): ReadonlyArray<{ x: number; y: number }> | undefined {
  const geo = shapeGeometryById(id, shapes);
  if (!geo || geo.kind === 'rect') return undefined;
  return shapeOutlinePoints(geo, w, h);
}
