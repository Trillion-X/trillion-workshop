// packages/group/show/board-palettes.ts
//
// The board colour-PALETTE leaf (cont.23) — pure, zero I/O, framework-agnostic. Applies a named
// cohesive THEME (Sunset / Ocean / Forest / Candy / Mono …) to a selection, so a scattered board of
// mismatched sticky colours becomes visually coherent in one click. The palette catalog is DATA
// (the #117 "ui-stays-blind catalog" pattern — a new theme is one row, zero code); the ASSIGNMENT
// (which item gets which palette colour) is an INJECTED strategy, so "recolour to a theme" is ONE
// mechanism and cycle / harmonise-by-hue / (future) by-group are each a pure function of it (L069).
// Composes the shipped colour primitives: `hueOf` (cont.18) drives nearest-hue harmonising, and the
// recoloured notes auto-get legible text via `readableInkFor` (cont.21) with ZERO extra work here.

import { hueOf } from './item-fill.ts';
import { HARMONY_SCHEMES, harmonize } from '../do-work/color-harmony.ts';

/** One named palette — an ordered list of hex colours. Ordered so `cycleAssign` flows predictably. */
export interface BoardPalette {
  readonly id: string;
  readonly label: string;
  readonly colors: readonly string[];
}

/** The curated theme catalog (Society DATA). A new theme is ONE row — zero render/apply code. */
const CURATED_PALETTES: readonly BoardPalette[] = [
  { id: 'sunset', label: 'Sunset', colors: ['#fecaca', '#fed7aa', '#fde68a', '#fbcfe8', '#ddd6fe'] },
  { id: 'ocean', label: 'Ocean', colors: ['#bfdbfe', '#a5f3fc', '#bbf7d0', '#c7d2fe', '#e0f2fe'] },
  { id: 'forest', label: 'Forest', colors: ['#bbf7d0', '#d9f99d', '#fde68a', '#a7f3d0', '#e7e5c8'] },
  { id: 'candy', label: 'Candy', colors: ['#fbcfe8', '#fecaca', '#ddd6fe', '#bfdbfe', '#fef08a'] },
  { id: 'mono', label: 'Mono', colors: ['#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b'] },
];

/** b103 — colour-theory harmony palettes GENERATED from one seed hue by `color-harmony`. Each `HARMONY_SCHEMES`
 *  row (complementary/triadic/analogous/tetradic) becomes a palette here and, via the bulk bar's catalog→action
 *  map, a "Palette: <name>" recolour action — zero per-scheme code (L069/L090). The seed is a pleasant blue;
 *  the schemes rotate it into distinct cohesive sets (blue+orange, blue+red+green, related blues, 4-way). */
const HARMONY_SEED = '#3b82f6';
const HARMONY_PALETTES: readonly BoardPalette[] = HARMONY_SCHEMES.map((s) => ({
  id: `harmony-${s.id}`,
  label: s.label,
  colors: harmonize(HARMONY_SEED, s, 5),
}));

/** The full theme catalog: curated themes + generated harmony palettes. A new theme = one curated row OR one
 *  `HARMONY_SCHEMES` row; both auto-surface as recolour actions with zero action code. */
export const BOARD_PALETTES: readonly BoardPalette[] = [...CURATED_PALETTES, ...HARMONY_PALETTES];

/** Resolve a palette id to its DATA (unknown/absent → the first palette, never empty). */
export function paletteById(id: string | undefined, catalog: readonly BoardPalette[] = BOARD_PALETTES): BoardPalette {
  return catalog.find((p) => p.id === id) ?? catalog[0];
}

/** An item as this leaf sees it — an id + its CURRENT fill (for hue-aware strategies). Blind to the
 *  full board item (L090); the wrapper extracts `fill` via `itemFillColor`. */
export interface PaletteItem {
  readonly memberId: string;
  readonly fill?: string;
}

/** The injected recolour strategy: given an item, its index in reading order, and the palette,
 *  return the colour to paint it — or `null` to leave it unchanged. */
export type PaletteAssign = (item: PaletteItem, index: number, palette: BoardPalette) => string | null;

/** CYCLE: round-robin the palette in reading order — the intuitive "apply this theme". Empty
 *  palette → null (no change). */
export const cycleAssign: PaletteAssign = (_item, index, palette) =>
  palette.colors.length === 0 ? null : palette.colors[index % palette.colors.length];

/** Circular hue distance (0..180) between two hues on the colour wheel (350 vs 10 = 20, not 340). */
function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/** HARMONISE: map each item's CURRENT fill to the palette colour of NEAREST hue — so a board's
 *  existing colour RELATIONSHIPS are preserved while snapping every colour into the theme (reds→the
 *  theme's warmest, blues→its coolest). Achromatic/absent fills (no hue) fall back to `cycleAssign`
 *  (deterministic). If no palette colour has a hue (e.g. Mono), also falls back to cycle. Ties →
 *  the lowest-index palette colour (stable, since we only replace on a strictly-closer hue). */
export const nearestHueAssign: PaletteAssign = (item, index, palette) => {
  const h = hueOf(item.fill);
  if (h === null) return cycleAssign(item, index, palette);
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of palette.colors) {
    const ph = hueOf(c);
    if (ph === null) continue; // achromatic palette colour can't hue-match
    const d = hueDistance(h, ph);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ?? cycleAssign(item, index, palette);
};

/** FIXED: paint each item the colour a PRE-COMPUTED map assigns it (absent → leave unchanged). The
 *  bridge that lets "colour by facet" reuse this recolour engine: the caller resolves each item to a
 *  STABLE per-value colour via `facetColorAssignment` (which owns the value→colour SSOT so a legend
 *  and the paint agree), then hands the resulting memberId→colour map here. This leaf stays blind to
 *  WHAT produced the colours (L090/L098). Index/palette are ignored — the colour is already decided. */
export function fixedColorAssign(colorByMember: ReadonlyMap<string, string>): PaletteAssign {
  return (item) => colorByMember.get(item.memberId) ?? null;
}

/** Recolour `items` to `palette` via the injected `assign`, in the given order (the wrapper sorts by
 *  reading position first). Returns one `{memberId, color}` patch per item the strategy colours;
 *  items the strategy leaves (`null`) are omitted. Pure — the wrapper applies each via `setStackFill`. */
export function recolorToPalette(
  items: readonly PaletteItem[],
  palette: BoardPalette,
  assign: PaletteAssign,
): Array<{ memberId: string; color: string }> {
  const out: Array<{ memberId: string; color: string }> = [];
  items.forEach((it, i) => {
    const color = assign(it, i, palette);
    if (typeof color === 'string') out.push({ memberId: it.memberId, color });
  });
  return out;
}
