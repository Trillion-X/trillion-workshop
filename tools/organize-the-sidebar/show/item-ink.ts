// packages/group/show/item-ink.ts
//
// The readable-ink leaf (cont.21) — pure, zero I/O, framework-agnostic. WCAG contrast math that
// picks the TEXT colour a note should use so its words stay legible on WHATEVER fill it carries.
// A dark-filled note gets light ink; a light-filled note gets dark ink — one luminance function,
// zero per-colour code (L069 emergence: readable text for infinite fills, never a per-swatch case).
// Reuses the ONE colour reader `parseRgb` (item-fill, cont.18) so the ink and the fill share one
// truth. Blind to WHICH fill — it never enumerates swatches (L090). The renderer applies the ink
// only when a fill is present, so an unfilled note is byte-identical (zero regression), and any
// explicit rich-text span colour still wins by CSS specificity (this only sets the inherited base).

import { parseRgb } from './item-fill.ts';

// The two ink poles. Not pure #000/#fff — a near-black + near-white read softer while still
// clearing WCAG AAA on their opposite fills. DATA constants, overridable per call.
export const INK_DARK = '#111827'; // slate-900-ish
export const INK_LIGHT = '#f8fafc'; // slate-50-ish

/** One sRGB channel (0..255) → its linear-light value (0..1), per WCAG 2.x. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black … 1 = white) of a colour, or null if unparseable. */
export function relativeLuminance(color: string | undefined): number | null {
  const rgb = parseRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(linearize) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1 … 21) between two colours; null if either is unparseable. Order-
 *  independent. 4.5 = the AA threshold for body text, 7 = AAA. */
export function contrastRatio(a: string | undefined, b: string | undefined): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA threshold for normal-size body text. */
export const AA_CONTRAST = 4.5;
const PURE_DARK = '#000000';
const PURE_LIGHT = '#ffffff';

/** The legible ink colour for `fill`. `undefined` when the fill can't be parsed (gradient/mesh/
 *  absent) → the caller applies no override and the note keeps its default text (zero regression).
 *
 *  Correctness (WCAG-converged): the SIDE (dark vs light) is chosen by the PURE #000/#fff extremes,
 *  whose contrast is guaranteed ≥4.58:1 against any opaque fill — so the fallback always clears AA
 *  even for awkward mid-luminance fills (~L 0.21) where the SOFT near-inks alone dip to ~3.9:1. On
 *  the chosen side we use the soft pole (nicer than pure) IFF it still clears AA, else escalate to
 *  the pure extreme. An injected pole is the caller's theme choice and is honoured as-is (no
 *  escalation). The choice is always contrast-driven — never a per-colour mapping (L069/L090). */
export function readableInkFor(
  fill: string | undefined,
  inks: { dark?: string; light?: string } = {},
): string | undefined {
  if (relativeLuminance(fill) === null) return undefined;
  // Side by the guaranteed-AA pure extremes: dark ink wins on a light fill, light ink on a dark one.
  const darkSide = (contrastRatio(fill, PURE_DARK) ?? 0) >= (contrastRatio(fill, PURE_LIGHT) ?? 0);
  if (darkSide) {
    if (inks.dark) return inks.dark; // caller's theme pole — respected as-is
    return (contrastRatio(fill, INK_DARK) ?? 0) >= AA_CONTRAST ? INK_DARK : PURE_DARK;
  }
  if (inks.light) return inks.light;
  return (contrastRatio(fill, INK_LIGHT) ?? 0) >= AA_CONTRAST ? INK_LIGHT : PURE_LIGHT;
}
