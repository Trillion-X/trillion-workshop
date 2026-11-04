// packages/group/show/item-fill.ts
//
// The item quick-fill leaf — pure, zero I/O. A board item's fill colour is ALREADY
// DATA: a `solid` capability layer (capabilityId 'solid', input { color }, a
// background z) inside the item's `extra.visualLayerStack` — the SAME record the
// Style → "Background & edge" editor edits. This leaf is the FAST PATH to that one
// source of truth: it reads/writes that solid layer so a one-click swatch and the
// full editor agree by construction (no parallel `extra.color` field — that would
// be a second source of truth for one visual). The blind `solid` capability paints
// it; this leaf adds zero rendering.

import type { AddressRef, VisualLayerStackRecord, VisualLayerDescriptor } from '../../ui/show/visual-layer-stack';
import { mergeCatalog } from '../read-data/catalog-merge';

/** The capabilityId of the built-in solid-colour fill (see visual-layer-stack
 *  capabilities/builtin.ts). A board fill IS a solid layer. */
const SOLID = 'solid';
/** Background z for the fill — behind the content layer (content sits at z 0). */
const FILL_Z = -1;
/** Stable id for a swatch-authored fill layer (idempotent; never collides with an
 *  editor-authored solid, which is matched by capabilityId instead). */
const FILL_ID = 'fill';

type ItemLike = { extra?: Record<string, unknown> | undefined } | undefined;

/** The item's current visual-layer-stack record, if any. */
function stackOf(item: ItemLike): VisualLayerStackRecord | undefined {
  const s = item?.extra?.visualLayerStack;
  return s && typeof s === 'object' ? (s as VisualLayerStackRecord) : undefined;
}

/** A CSS colour is a short token (`#rrggbb`, `rgb(…)`, a `var(--…)` name). A persisted/capsule item's
 *  colour is UNTRUSTED — a megabyte string would be copied again by `trim().toLowerCase()` and handed to
 *  the renderer (CPU/memory DoS). Cap it at the ONE fill reader; no real colour approaches 4KB. (Kept
 *  well above an oversized-but-parseable channel like `rgb(999…9,0,0)`, which `parseRgb` still clamps to
 *  255 — this bound only defuses the megabyte-scale abuse, it does not replace the per-channel clamp.) */
const MAX_COLOR_LEN = 4096;

/** The first solid-fill layer in a stack (the item's background fill), or undefined. `layers` is
 *  UNTRUSTED persisted DATA — `Array.isArray` guards a non-array (`{layers:"x"}` → `"x".find` is
 *  undefined → TypeError crash), and the per-entry object guard skips a `null`/primitive layer. */
function solidLayer(stack: VisualLayerStackRecord | undefined): VisualLayerDescriptor | undefined {
  const layers = stack?.layers;
  if (!Array.isArray(layers)) return undefined;
  return layers.find((l) => l && typeof l === 'object' && l.paint?.capability?.capabilityId === SOLID);
}

/** The item's current fill colour (the first solid layer's `input.color`), or undefined. Fail-closed on
 *  an absurdly long colour (untrusted DATA) — never hand a megabyte string to the renderer/colour math. */
export function itemFillColor(item: ItemLike): string | undefined {
  const c = solidLayer(stackOf(item))?.paint?.input?.color;
  return typeof c === 'string' && c.length <= MAX_COLOR_LEN ? c : undefined;
}

/** Parse a CSS colour string → its `[r,g,b]` (0-255), or null if not a plain hex/rgb value
 *  (e.g. a `var(--…)`, `none`, or a keyword — which a spectrum sort can't rank). Supports
 *  `#rgb`, `#rrggbb`, and `rgb(r,g,b)`. Pure, never throws. */
export function parseRgb(color: string | undefined): [number, number, number] | null {
  if (typeof color !== 'string' || color.length > MAX_COLOR_LEN) return null; // length cap BEFORE trim/lowercase copy
  const s = color.trim().toLowerCase();
  const hex = s.startsWith('#') ? s.slice(1) : null;
  if (hex && /^[0-9a-f]{3}$/.test(hex)) return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
  if (hex && /^[0-9a-f]{6}$/.test(hex)) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  // CSS-faithful clamp to [0,255]. A hostile/oversized fill (a persisted/capsule item's colour is
  // untrusted DATA) like `rgb(<hundreds of 9s>,0,0)` makes `Number(...) === Infinity`, and even
  // `rgb(999,0,0)` exceeds 255 — either poisons the downstream HSL math into NaN and makes
  // color-harmony emit an invalid `#NaNNaNNaN`. `\d+` is always ≥ 0, so `Math.min(255, …)` (Infinity → 255)
  // is a no-op for every in-range colour and defuses the rest at the ONE colour reader (L055 root / L063).
  if (m) return [Math.min(255, Number(m[1])), Math.min(255, Number(m[2])), Math.min(255, Number(m[3]))];
  return null;
}

/** The colour's HUE on the 0-360 wheel (red 0 → yellow 60 → green 120 → cyan 180 → blue 240 →
 *  magenta 300), or null when it has no meaningful hue: unparseable, OR ACHROMATIC (grey/white/
 *  black — near-zero saturation). Lets a "Sort by colour" arrangement lay items out as a rainbow
 *  and push the greys to the end. Pure, never throws. */
export function hueOf(color: string | undefined): number | null {
  const rgb = parseRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.04) return null; // achromatic → no hue
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * Set (or clear, when `color === null`) the stack's solid fill. If a solid layer
 * exists its colour is patched (or it is removed on clear); otherwise a solid layer
 * is added at the background z. Pure — returns a new record, never mutates. The
 * `registry` is the owner's layer-capability registry address (the board passes its
 * own; this leaf names no address). A stack starts from `base` when the item has none.
 */
export function setStackFill(
  stack: VisualLayerStackRecord,
  color: string | null,
  registry: AddressRef,
): VisualLayerStackRecord {
  // `stack.layers` is UNTRUSTED — coerce a non-array to [] before any find/filter/map/spread.
  const base = Array.isArray(stack.layers) ? stack.layers : [];
  const existing = solidLayer(stack);
  let layers: VisualLayerDescriptor[];
  if (color === null) {
    // Match by OBJECT IDENTITY, not `l.id`: a corrupted stack with duplicate layer ids would otherwise
    // remove/patch UNRELATED same-id layers. `existing` is the exact object `solidLayer` found.
    layers = existing ? base.filter((l) => l !== existing) : [...base];
  } else if (existing) {
    layers = base.map((l) =>
      l === existing ? { ...l, paint: { ...l.paint, input: { ...l.paint.input, color } } } : l,
    );
  } else {
    const fill: VisualLayerDescriptor = {
      id: FILL_ID,
      order: { z: FILL_Z },
      paint: { capability: { registry, capabilityId: SOLID }, input: { color } },
    };
    layers = [fill, ...base];
  }
  return { ...stack, layers };
}

/** A fresh empty stack for an item that has none yet (region = the item's parent). */
export function emptyStack(region: AddressRef): VisualLayerStackRecord {
  return { kind: 'visual-layer-stack', version: 1, region, layers: [] };
}

/** The board's item-layer capability registry — the canonical address the board passes
 *  to {@link setStackFill} (and to the item's `<VisualLayerStack>` renderer). It lives
 *  HERE (the fill owner) so every fill writer shares ONE source of truth (L030), rather
 *  than each call site re-declaring the same `{ family, parts }` literal. */
export const BOARD_ITEM_LAYER_REGISTRY: AddressRef = { family: 'group.board-item-layers', parts: {} };

/**
 * Build a ready-to-place fill stack for a freshly-created item: ONE solid layer of
 * `color`, via the SAME {@link setStackFill} the #124 swatch and the Style editor use —
 * so a seeded colour and a later recolour edit the SAME source of truth (no parallel
 * colour field). The `region` is a placeholder here (the item has no parent yet at draft
 * time); it is cosmetic — rendering reads only `stack.layers`, never `stack.region` — and
 * is corrected to the real parent the first time a bundle is applied. Pure.
 */
export function seededFillStack(color: string): VisualLayerStackRecord {
  return setStackFill(emptyStack(BOARD_ITEM_LAYER_REGISTRY), color, BOARD_ITEM_LAYER_REGISTRY);
}

/** The fill stack + connector colour a freshly-created mind-map child inherits (#167). */
export interface InheritedBranchStyle {
  /** Ready-to-place fill stack for the new child note (ONE solid layer of the parent's colour). */
  readonly fillStack: VisualLayerStackRecord;
  /** Colour for the connector linking parent → child (whole branch = one colour, #166). */
  readonly connectorColor: string;
}

/**
 * #167 — the branch colour a freshly-created mind-map child (and its connector) inherit
 * from its parent, so the #165/#166 rainbow stays LIVE as you keyboard-build (Tab/Enter,
 * MindNode/XMind canon). Reads the parent's fill via {@link itemFillColor}; when the parent
 * is coloured, returns the child's ready {@link seededFillStack} + the same colour for the
 * connector — the caller applies both in ONE undoable commit. Parent uncoloured (e.g. the
 * neutral root) → `null`: the child stays neutral until "Color branches" assigns the next
 * palette hue. Pure DATA — this leaf names no graph and imports no engine; the panel plumbs
 * the result through `patchItem`. SSOT: the SAME `seededFillStack`/`itemFillColor` the #124
 * swatch and Style editor use, so a seeded branch colour and a later recolour agree.
 */
export function inheritedBranchStyle(parent: ItemLike): InheritedBranchStyle | null {
  const color = itemFillColor(parent);
  return color ? { fillStack: seededFillStack(color), connectorColor: color } : null;
}

/** One selectable fill — `color: null` is the "None" (clear) swatch. */
export interface FillSwatch {
  readonly id: string;
  readonly label: string;
  readonly color: string | null;
}

/** The published-record payload kind carrying user-defined fill swatches (Society DATA). */
export const FILL_SWATCH_CATALOG_KIND = 'fill-swatch-catalog';

/**
 * The board fill palette — Society DATA in the feature package (the sticky-note
 * colour set: a soft, legible spread plus neutrals, with "None" to clear). Full
 * colour freedom remains via the wheel; these are the one-click fast picks.
 */
export const BOARD_FILL_SWATCHES: readonly FillSwatch[] = [
  { id: 'none', label: 'None', color: null },
  { id: 'yellow', label: 'Yellow', color: '#fde68a' },
  { id: 'green', label: 'Green', color: '#bbf7d0' },
  { id: 'blue', label: 'Blue', color: '#bfdbfe' },
  { id: 'pink', label: 'Pink', color: '#fbcfe8' },
  { id: 'purple', label: 'Purple', color: '#ddd6fe' },
  { id: 'orange', label: 'Orange', color: '#fed7aa' },
  { id: 'red', label: 'Red', color: '#fecaca' },
  { id: 'gray', label: 'Gray', color: '#e5e7eb' },
  { id: 'dark', label: 'Dark', color: '#1f2937' },
] as const;

/** Validate one untrusted fill swatch DATA row. `id` and `label` are required; `color`
 *  can be null (the "None" swatch) or a CSS colour string. */
function fillSwatchFromData(row: Record<string, unknown>): FillSwatch | null {
  if (typeof row.id === 'string' && typeof row.label === 'string') {
    // color can be null or string
    const color = row.color === null || typeof row.color === 'string' ? row.color : undefined;
    if (color !== undefined) {
      return { id: row.id, label: row.label, color };
    }
  }
  return null;
}

/**
 * The EFFECTIVE fill swatch catalog = the built-in {@link BOARD_FILL_SWATCHES} plus any
 * user-defined swatches from `fill-swatch-catalog` published-records (Society DATA), via
 * the generic {@link mergeCatalog} primitive — so "which swatches exist" is DATA. A DATA
 * row overrides a built-in by id, else appends.
 */
export function readFillSwatchCatalog(
  records: ReadonlyArray<{ payload?: unknown }>,
): FillSwatch[] {
  return mergeCatalog(records, {
    kind: FILL_SWATCH_CATALOG_KIND,
    arrayKey: 'swatches',
    idOf: (s) => s.id,
    parseRow: fillSwatchFromData,
    builtins: BOARD_FILL_SWATCHES,
  });
}
