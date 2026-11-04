// packages/group/show/filter-presets.ts
//
// The board's catalog of named image-color presets — pure DATA. Each preset maps a
// human label to a CSS `filter` string; an image carries the chosen CSS string as
// `extra.imageFilter`, which the blind `MediaFrame` applies verbatim. Adding a preset
// is one DATA row here — zero engine/render code changes (L090). The picker (in the
// Style popover) renders these labels and reports an id; it never knows what a filter
// IS. This is Society DATA living in the feature package, not the ui engine.

/** One named image filter: a label the user picks + the CSS `filter` it applies. */
export interface FilterPreset {
  /** Stable id stored/looked-up (never the label — labels can change). */
  id: string;
  /** Human label shown on the chip. */
  label: string;
  /** The CSS `filter` value applied to the `<img>` (`''` = no filter). */
  css: string;
}

/** The starting aesthetic catalog. Order = display order; `none` is first. */
export const BOARD_FILTER_PRESETS: readonly FilterPreset[] = [
  { id: 'none', label: 'None', css: '' },
  { id: 'bw', label: 'B&W', css: 'grayscale(1)' },
  { id: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.3) brightness(0.95)' },
  { id: 'sepia', label: 'Sepia', css: 'sepia(0.7)' },
  { id: 'vivid', label: 'Vivid', css: 'saturate(1.6) contrast(1.1)' },
  { id: 'warm', label: 'Warm', css: 'sepia(0.3) saturate(1.3) hue-rotate(-10deg)' },
  { id: 'cool', label: 'Cool', css: 'saturate(1.1) hue-rotate(15deg) brightness(1.03)' },
  { id: 'fade', label: 'Fade', css: 'contrast(0.85) brightness(1.08) saturate(0.85)' },
];

/** Resolve a preset id → its CSS filter string (`''` when none/unknown). */
export function filterCssById(
  id: string | undefined,
  presets: readonly FilterPreset[] = BOARD_FILTER_PRESETS,
): string {
  if (!id) return '';
  return presets.find((p) => p.id === id)?.css ?? '';
}

/** Reverse-lookup the active preset id from a stored CSS string (for highlighting the
 *  active chip). An empty/missing css → the first (`none`) preset; an unrecognized css
 *  → `''` (no chip highlighted, the value was set outside the catalog). */
export function presetIdForCss(
  css: string | undefined,
  presets: readonly FilterPreset[] = BOARD_FILTER_PRESETS,
): string {
  const want = (css ?? '').trim();
  if (want === '') return presets[0]?.id ?? '';
  return presets.find((p) => p.css === want)?.id ?? '';
}
