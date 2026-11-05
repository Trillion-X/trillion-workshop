// packages/group/show/color-harmony.ts
//
// The colour-HARMONY leaf (cont.24) — pure, zero I/O, framework-agnostic. From ONE seed colour it
// generates a cohesive colour-theory scheme (complementary / analogous / triadic / split-
// complementary / tetradic / monochromatic) by rotating the seed's HUE on the colour wheel and
// varying lightness/saturation. ONE HSL-rotation engine × an INJECTED set of stops (DATA) → any
// scheme with ZERO per-scheme code (L069): a new scheme is one catalog row. Composes cont.18's
// `parseRgb` (one colour reader) and feeds cont.23's `recolorToPalette` (a generated scheme IS a
// palette). Blind to which scheme (L090). The board's designer picks a sticky colour and gets a
// whole harmonised theme — the colour-theory move a manual swatch grid can't do.

import { parseRgb } from './item-fill.ts';

/** One scheme stop: a hue rotation off the seed (degrees) plus optional lightness/saturation shift
 *  (−1..1, added then clamped). Monochromatic uses hueRotate 0 with varying `lightDelta`. */
export interface HarmonyStop {
  readonly hueRotate: number;
  readonly lightDelta?: number;
  readonly satDelta?: number;
}

/** A named colour-theory scheme — an ordered list of stops relative to the seed. Society DATA. */
export interface HarmonyScheme {
  readonly id: string;
  readonly label: string;
  readonly stops: readonly HarmonyStop[];
}

/** The built-in scheme catalog (canonical colour theory). A new scheme is ONE row — zero engine. */
export const BOARD_HARMONY_SCHEMES: readonly HarmonyScheme[] = [
  { id: 'complementary', label: 'Complementary', stops: [{ hueRotate: 0 }, { hueRotate: 180 }] },
  { id: 'analogous', label: 'Analogous', stops: [{ hueRotate: -30 }, { hueRotate: 0 }, { hueRotate: 30 }] },
  { id: 'triadic', label: 'Triadic', stops: [{ hueRotate: 0 }, { hueRotate: 120 }, { hueRotate: 240 }] },
  { id: 'split-complementary', label: 'Split complementary', stops: [{ hueRotate: 0 }, { hueRotate: 150 }, { hueRotate: 210 }] },
  { id: 'tetradic', label: 'Tetradic', stops: [{ hueRotate: 0 }, { hueRotate: 90 }, { hueRotate: 180 }, { hueRotate: 270 }] },
  {
    id: 'monochromatic',
    label: 'Monochromatic',
    stops: [{ hueRotate: 0, lightDelta: -0.24 }, { hueRotate: 0, lightDelta: -0.1 }, { hueRotate: 0 }, { hueRotate: 0, lightDelta: 0.14 }],
  },
];

/** Resolve a scheme id to its DATA (unknown/absent → the first scheme, never empty). */
export function schemeById(id: string | undefined, catalog: readonly HarmonyScheme[] = BOARD_HARMONY_SCHEMES): HarmonyScheme {
  return catalog.find((s) => s.id === id) ?? catalog[0];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** sRGB [0..255]³ → HSL (h 0..360, s 0..1, l 0..1). Achromatic (r=g=b) → hue 0, sat 0. */
export function rgbToHsl([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l]; // achromatic
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}

/** HSL (h 0..360, s 0..1, l 0..1) → sRGB [0..255]³ (rounded). */
export function hslToRgb([h, s, l]: readonly [number, number, number]): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v]; // achromatic
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hh < 60) [r1, g1, b1] = [c, x, 0];
  else if (hh < 120) [r1, g1, b1] = [x, c, 0];
  else if (hh < 180) [r1, g1, b1] = [0, c, x];
  else if (hh < 240) [r1, g1, b1] = [0, x, c];
  else if (hh < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

/** Format an sRGB triple as `#rrggbb`. */
export function toHex([r, g, b]: readonly [number, number, number]): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Generate the harmonised colours for `seedHex` under `scheme`: for each stop, rotate the seed's
 * hue by `hueRotate` (mod 360) and shift lightness/saturation (clamped to [0.06, 0.96] / [0,1] so
 * every colour stays visible), then convert back to hex. Returns one hex per stop. Unparseable seed
 * → `[seedHex]` (best effort, never throws). An achromatic seed (grey) stays grey under hue rotation
 * — colour-theory-honest (grey has no hue); monochromatic still varies its lightness.
 */
export function harmonize(seedHex: string | undefined, scheme: HarmonyScheme): string[] {
  const rgb = parseRgb(seedHex);
  if (!rgb) return typeof seedHex === 'string' && seedHex ? [seedHex] : [];
  const [h, s, l] = rgbToHsl(rgb);
  return scheme.stops.map((stop) => {
    const h2 = h + stop.hueRotate;
    const s2 = clamp01(s + (stop.satDelta ?? 0));
    const l2 = Math.max(0.06, Math.min(0.96, l + (stop.lightDelta ?? 0)));
    return toHex(hslToRgb([h2, s2, l2]));
  });
}
