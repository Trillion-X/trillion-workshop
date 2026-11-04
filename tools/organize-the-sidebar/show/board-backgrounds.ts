// packages/group/show/board-backgrounds.ts
//
// The board surface catalog — Society DATA in the FEATURE package (the #117
// "ui-stays-blind catalog" pattern). A board's surface look (its color + an
// optional repeating tile) is a per-board choice persisted as the catalog id on
// the board's index member (`presentation.background`). The blind `CanvasSurface`
// ui primitive renders the resolved { color, tile } and never knows what a
// "blueprint" or "legal pad" is — meaning lives here, in DATA.
//
// Adding a new surface is ONE row below — zero new render code (CanvasSurface is
// the generic primitive; this is its configuration set). Each `tile.image` is an
// opaque CSS background-image string; `tile.size` is the tile edge in WORLD px at
// zoom 1 (it pans/scales with the camera). Token colors for theme-aware looks;
// explicit colors for fixed paper/ink moods that must read the same in any theme.

import type { CanvasSurfaceTile } from '../../ui';
import { mergeCatalog } from '../read-data/catalog-merge';

/** One selectable board surface. `color` is the solid backdrop (absent →
 *  transparent); `tile` is the repeating pattern (absent → a plain surface). */
export interface BoardBackground {
  readonly id: string;
  readonly label: string;
  readonly color?: string;
  readonly tile?: CanvasSurfaceTile;
}

const DOT = (color: string, opacity = 0.5): CanvasSurfaceTile => ({
  image: `radial-gradient(circle, ${color} 1px, transparent 1px)`,
  size: 24,
  opacity,
});
const GRID = (color: string, size = 24, opacity = 0.4): CanvasSurfaceTile => ({
  image: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`,
  size,
  opacity,
});
const RULED = (color: string, size = 28, opacity = 0.5): CanvasSurfaceTile => ({
  image: `linear-gradient(${color} 1px, transparent 1px)`,
  size,
  opacity,
});

/**
 * The board surface catalog. `dots` is FIRST and is the DEFAULT — an unset board
 * keeps the canvas's original dot-grid look (L083: the default is the current,
 * fully-capable behavior, never a degraded blank).
 */
export const BOARD_BACKGROUNDS: readonly BoardBackground[] = [
  { id: 'dots', label: 'Dots', tile: DOT('var(--border-primary)') },
  // "None" = a plain surface with no color and no tile. Kept as catalog id 'blank'
  // (persistence compat) but labelled "None" and pulled to the FRONT of the picker
  // grid (display-only, see BoardBackgroundPicker) so a board is never FORCED to wear
  // a pattern (R46). NOT catalog[0] — 'dots' stays the resolved default for an unset
  // board (backgroundById falls back to catalog[0]); existing unset boards keep dots.
  { id: 'blank', label: 'None' },
  // cont.26 — a warm off-white PAPER canvas (the Excalidraw/tldraw whiteboard default) that completes
  // the hand-drawn sketch aesthetic: pencil connectors + pencil note borders + handwritten font read as
  // a real whiteboard on this surface. Plain color, no tile — one DATA row, zero render code (L090).
  { id: 'paper', label: 'Paper', color: '#fbfbf9' },
  { id: 'grid', label: 'Grid', tile: GRID('var(--border-primary)') },
  { id: 'lines', label: 'Lines', tile: RULED('var(--border-primary)') },
  { id: 'graph-paper', label: 'Graph paper', color: '#ffffff', tile: GRID('rgba(45,120,90,0.18)', 12, 1) },
  { id: 'legal-pad', label: 'Legal pad', color: '#fbf7e8', tile: RULED('rgba(70,110,200,0.28)', 28, 1) },
  { id: 'blueprint', label: 'Blueprint', color: '#12315c', tile: GRID('rgba(255,255,255,0.18)', 24, 1) },
  { id: 'dark', label: 'Dark', color: '#17171c', tile: DOT('rgba(255,255,255,0.20)', 0.6) },
] as const;

/**
 * Resolve a stored background id to its surface DATA. An unknown / undefined id
 * falls back to the `dots` default, so an unset (or stale-id) board still renders
 * the canonical look rather than nothing.
 */
export function backgroundById(
  id: string | undefined,
  catalog: readonly BoardBackground[] = BOARD_BACKGROUNDS,
): BoardBackground {
  if (id) {
    const found = catalog.find((b) => b.id === id);
    if (found) return found;
  }
  return catalog[0] ?? BOARD_BACKGROUNDS[0];
}

/** The published-record payload kind carrying user-defined board backgrounds (Society DATA). */
export const BACKGROUND_CATALOG_KIND = 'background-catalog';

/** Validate one untrusted background DATA row. A background is a surface look: a solid `color`
 *  and/or a `tile` (dots/grid/ruled pattern — the tile object is opaque DATA passed straight to
 *  CanvasSurface). id/label required; both color and tile optional (blank = neither). */
function backgroundFromData(row: Record<string, unknown>): BoardBackground | null {
  if (typeof row.id !== 'string' || typeof row.label !== 'string') return null;
  return {
    id: row.id,
    label: row.label,
    ...(typeof row.color === 'string' ? { color: row.color } : {}),
    ...(row.tile && typeof row.tile === 'object' ? { tile: row.tile as CanvasSurfaceTile } : {}),
  };
}

/**
 * The board's EFFECTIVE background catalog = the built-in {@link BOARD_BACKGROUNDS} plus any
 * user-defined backgrounds from `background-catalog` published-records (Society DATA), via the
 * generic {@link mergeCatalog} primitive — so "which board surfaces exist" is DATA, not a source
 * const (mirrors the marker catalog). A DATA row overrides a built-in by id, else appends.
 */
export function readBackgroundCatalog(
  records: ReadonlyArray<{ payload?: unknown }>,
): BoardBackground[] {
  return mergeCatalog(records, {
    kind: BACKGROUND_CATALOG_KIND,
    arrayKey: 'backgrounds',
    idOf: (b) => b.id,
    parseRow: backgroundFromData,
    builtins: BOARD_BACKGROUNDS,
  });
}
