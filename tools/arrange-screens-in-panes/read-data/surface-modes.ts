// packages/screen-arrangement/read-data/surface-modes.ts
//
// Surface modes as DATA (B3b) — replaces the closed `'grid' | 'canvas'` union
// (and its Rust `Surface { Grid, Canvas }` twin). A mode is a self-describing
// `{ id, label, baseGeometry }` row. `surface` becomes an OPEN string the client
// renders by looking up its BASE GEOMETRY here — never by `=== 'canvas'`. Adding
// a mode ("stage", …) that reuses a geometry is ONE data row + ZERO render/slot
// code (L090). The slot reconciles only on the closed `baseGeometry` the command
// self-describes; it never inspects the open label.
//
// SSOT for surface modes: the header menu, the node-menu controller, the
// LayoutEngine renderer, and the setSurface action all import from here.

/** Open mode label — Society data, NOT a closed union. */
export type SurfaceMode = string;

/**
 * The closed set of base arrangement geometries the slot actually implements
 * (matches Rust `BaseSurfaceGeometry`, serde lowercase). Physics-closed: a new
 * geometry is new slot math, never a user/package extension. `overlay` is NOT a
 * base — it is an orthogonal always-present layer.
 */
export type BaseSurfaceGeometry = 'tiled' | 'floating';

/** A self-describing surface mode. */
export interface SurfaceModeDescriptor {
  readonly id: SurfaceMode;
  readonly label: string;
  readonly baseGeometry: BaseSurfaceGeometry;
  /** Shared icon name shown wherever this mode is offered as a choice. */
  readonly icon?: string;
}

/** Built-in modes. Owner/data may extend; menu + renderer + slot stay blind. */
export const SURFACE_MODES: readonly SurfaceModeDescriptor[] = [
  { id: 'grid', label: 'Tiles', baseGeometry: 'tiled', icon: 'Grid2X2' },
  { id: 'canvas', label: 'Canvas', baseGeometry: 'floating', icon: 'PanelsTopLeft' },
];

/** The mode used when none is set or the set label has no registered descriptor. */
export const DEFAULT_SURFACE_MODE: SurfaceMode = 'grid';

/** The geometry the default mode uses — the universal fallback. */
export const DEFAULT_BASE_GEOMETRY: BaseSurfaceGeometry = 'tiled';

/** Resolve a surface label to its base geometry (unknown label → default geometry). */
export function baseGeometryForSurface(surface: SurfaceMode): BaseSurfaceGeometry {
  return SURFACE_MODES.find((m) => m.id === surface)?.baseGeometry ?? DEFAULT_BASE_GEOMETRY;
}
