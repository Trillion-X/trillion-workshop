// packages/ui/show/color-wheel/color-math.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure, dependency-free HSVA <-> hex color math for the ColorWheel primitive.
// No React, no DOM. The ColorWheel UI carries color as HSVA internally (a wheel
// is a polar projection of Hue + a square of Saturation/Value) and emits an
// #rrggbb / #rrggbbaa hex string — the DATA shape every caller persists.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Pure functions only — same input always yields same output, no I/O.
// 2. HSVA is the canonical internal model: h∈[0,360), s,v,a∈[0,1].
// 3. Round-trips are stable to 8-bit channel precision (hex is 8-bit per
//    channel) — hexToHsva(hsvaToHex(x)) reproduces x within 1/255.
// 4. Parsing is tolerant of #rgb, #rgba, #rrggbb, #rrggbbaa (with/without '#').
// =============================================================================

/** Canonical internal color model. h∈[0,360), s/v/a∈[0,1]. */
export interface Hsva {
  readonly h: number;
  readonly s: number;
  readonly v: number;
  readonly a: number;
}

/** 8-bit RGBA, each channel 0..255 except a∈[0,1]. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const wrapHue = (h: number): number => ((h % 360) + 360) % 360;
const to255 = (n: number): number => Math.round(clamp01(n) * 255);

export function hsvaToRgba({ h, s, v, a }: Hsva): Rgba {
  const hue = wrapHue(h) / 60;
  const c = clamp01(v) * clamp01(s);
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = clamp01(v) - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue >= 0 && hue < 1) [r, g, b] = [c, x, 0];
  else if (hue < 2) [r, g, b] = [x, c, 0];
  else if (hue < 3) [r, g, b] = [0, c, x];
  else if (hue < 4) [r, g, b] = [0, x, c];
  else if (hue < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: to255(r + m), g: to255(g + m), b: to255(b + m), a: clamp01(a) };
}

export function rgbaToHsva({ r, g, b, a }: Rgba): Hsva {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
  }
  return { h: wrapHue(h), s: max === 0 ? 0 : d / max, v: max, a: clamp01(a) };
}

const hex2 = (n: number): string => to255(n / 255).toString(16).padStart(2, '0');

/** HSVA -> #rrggbb (a===1) or #rrggbbaa (a<1). */
export function hsvaToHex(hsva: Hsva): string {
  const { r, g, b, a } = hsvaToRgba(hsva);
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a >= 1 ? base : `${base}${Math.round(clamp01(a) * 255).toString(16).padStart(2, '0')}`;
}

/** Parse #rgb / #rgba / #rrggbb / #rrggbbaa (leading '#' optional). null if unparseable. */
export function parseHex(input: string): Rgba | null {
  const s = input.trim().replace(/^#/, '');
  const expand = (h: string): string => h.split('').map((c) => c + c).join('');
  let hex: string | null = null;
  if (/^[0-9a-fA-F]{3}$/.test(s)) hex = expand(s) + 'ff';
  else if (/^[0-9a-fA-F]{4}$/.test(s)) hex = expand(s);
  else if (/^[0-9a-fA-F]{6}$/.test(s)) hex = s + 'ff';
  else if (/^[0-9a-fA-F]{8}$/.test(s)) hex = s;
  if (!hex) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: parseInt(hex.slice(6, 8), 16) / 255,
  };
}

/** Parse any supported hex into HSVA. Returns null when unparseable. */
export function hexToHsva(input: string): Hsva | null {
  const rgba = parseHex(input);
  return rgba ? rgbaToHsva(rgba) : null;
}

/** The flat hue base color (full S/V) for a given hue — used to paint the SV square. */
export function hueBaseHex(h: number): string {
  return hsvaToHex({ h, s: 1, v: 1, a: 1 });
}
