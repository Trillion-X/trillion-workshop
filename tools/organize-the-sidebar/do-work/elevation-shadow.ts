// packages/group/do-work/elevation-shadow.ts
//
// CARD ELEVATION — the generative primitive behind "a card can sit flat, be RAISED off the board, or be
// PRESSED into it" (the Miro/FigJam/Material depth cue that lets one card stand out from the rest). Depth
// is a single signed LEVEL: the shadow is COMPUTED from it, not looked up in a fixed table — so level 7
// works even though no preset names it, and the SAME formula yields three emergent looks from one number:
//   • level > 0 → RAISED: a two-layer drop shadow (a soft key light + a tight ambient) that grows with level
//   • level = 0 → FLAT: no shadow ('none')
//   • level < 0 → PRESSED: an INSET shadow whose depth grows with |level|
// That is L069/enum-dissolution applied to depth: the named presets (Low/Medium/High/Floating/Inset) are
// just DATA rows over this one resolver, and a blind card applies the returned `box-shadow` string verbatim.
//
// Pure leaf (no React/DOM). Values are clamped so an extreme or malformed level never produces NaN CSS or
// an absurd blur; level 0 / non-finite → 'none' (byte-identical to an unstyled card).

const MAX_LEVEL = 24; // clamp so a runaway level can't emit a page-filling blur
const MAX_ALPHA = 0.34; // clamp shadow opacity so deep levels stay a shadow, not a black box

function clampAlpha(a: number): number {
  return Math.min(MAX_ALPHA, Math.max(0, a));
}

/**
 * The CSS `box-shadow` for a signed elevation `level`. Positive → a raised two-layer shadow (key + ambient)
 * whose offset/blur/opacity scale with the level; negative → an inset (pressed) shadow; 0 or non-finite →
 * `'none'`. One computed formula, every level, zero per-level code — the named presets are DATA over this.
 */
export function elevationShadow(level: number): string {
  if (!Number.isFinite(level) || level === 0) return 'none';
  if (level < 0) {
    const d = Math.min(-level, MAX_LEVEL);
    const y = Math.round(d * 1.5);
    const blur = Math.round(d * 2.5);
    return `inset 0 ${y}px ${blur}px rgba(15, 23, 42, ${clampAlpha(0.08 + d * 0.02).toFixed(3)})`;
  }
  const l = Math.min(level, MAX_LEVEL);
  const key = `0 ${(l * 1.5).toFixed(1)}px ${(l * 4).toFixed(1)}px rgba(15, 23, 42, ${clampAlpha(0.05 + l * 0.02).toFixed(3)})`;
  const ambient = `0 ${(l * 0.5).toFixed(1)}px ${(l * 1.5).toFixed(1)}px rgba(15, 23, 42, ${clampAlpha(0.04 + l * 0.012).toFixed(3)})`;
  return `${key}, ${ambient}`;
}

/** The named depth presets as DATA (the picker's rows); the resolver above is blind to this list — a new
 *  preset is one row, and any level (including ones no row names) resolves identically through the formula. */
export const ELEVATION_LEVELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Flat' },
  { value: '1', label: 'Low' },
  { value: '2', label: 'Medium' },
  { value: '4', label: 'High' },
  { value: '6', label: 'Floating' },
  { value: '-2', label: 'Pressed (inset)' },
];
