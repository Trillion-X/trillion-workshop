// packages/group/do-work/color-harmony.ts
//
// COLOUR HARMONY — the generative primitive behind "make me a matching palette" (colour-theory schemes:
// complementary, triadic, analogous, tetradic). `harmonize(seed, scheme)` rotates the seed's hue by the
// scheme's offsets (keeping a soft sticky-pastel saturation/lightness) to produce a cohesive colour list. The
// tokenizer NEVER names a scheme — it iterates an INJECTED `HARMONY_SCHEMES` map, so each scheme is a DATA row
// of hue offsets and a NEW scheme is one row with ZERO engine change (enum-dissolution / L090). It composes
// the shipped colour surface: the generated lists are added to `show/board-palettes` `BOARD_PALETTES`, so each
// harmony auto-becomes a "Palette: <name>" recolour action on the bulk bar (the same catalog→action map the
// curated themes use) — zero new wiring. Complements b102 (which EXTRACTS a palette from an image); this one
// GENERATES a palette from a seed colour. Pure leaf: zero I/O, deterministic (HSL math — no Date/random).

export interface HarmonyScheme {
  readonly id: string;
  readonly label: string;
  /** Hue rotations (degrees) applied to the seed hue, one per generated colour (cycled if fewer than count). */
  readonly offsets: readonly number[];
}

/** The built-in schemes — DATA, not code branches. The FIRST two offsets express each scheme's core
 *  relationship (complementary +180, triadic +120, analogous +30, tetradic +90); the rest fill a 5-colour
 *  sticky palette with related hues. A new scheme is one row. */
export const HARMONY_SCHEMES: readonly HarmonyScheme[] = [
  { id: 'complementary', label: 'Complementary', offsets: [0, 180, 20, 200, 40] },
  { id: 'triadic', label: 'Triadic', offsets: [0, 120, 240, 60, 180] },
  { id: 'analogous', label: 'Analogous', offsets: [0, 30, -30, 60, -60] },
  { id: 'tetradic', label: 'Tetradic', offsets: [0, 90, 180, 270, 45] },
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Parse a #rrggbb hex to HSL (h 0..360, s/l 0..1). A malformed hex → black (h0 s0 l0), never throws. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return { h: 0, s: 0, l: 0 };
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** HSL (h any degrees, s/l 0..1) → a lowercase #rrggbb hex. */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const lit = clamp01(l);
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lit - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; }
  else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Soft sticky-pastel band (matches the curated BOARD_PALETTES aesthetic) so recoloured notes stay legible. */
const HARMONY_S = 0.6;
const HARMONY_L = 0.82;

/**
 * `count` cohesive colours generated from `seed` by the `scheme`'s hue rotations, at a fixed pastel
 * saturation/lightness. Deterministic. A malformed seed → rotations of grey (still valid hex).
 */
export function harmonize(seedHex: string, scheme: HarmonyScheme, count = 5): string[] {
  const { h } = hexToHsl(seedHex);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const off = scheme.offsets.length ? scheme.offsets[i % scheme.offsets.length] : 0;
    out.push(hslToHex(h + off, HARMONY_S, HARMONY_L));
  }
  return out;
}
