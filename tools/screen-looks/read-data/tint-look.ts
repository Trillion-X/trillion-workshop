// tools/screen-looks/read-data/tint-look.ts
//
// PURPOSE
//   Any-tint looks: from ONE colour a person (or a space) picks, derive every accent-bearing token of a look so it stays
//   readable by construction. The colour contributes only its hue; lightness is pinned per role and scheme and chroma is
//   clamped per role and to the sRGB gamut (tools/screen-looks/read-data/tint-rules.json). The answer is a `changes` object for
//   changeScreenLookTokens (screen-look-record.ts), so the look owner still validates every value it writes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and blind: it names no look and no colour; roles, lightness and chroma limits are DATA.
//   2. Only the hue survives from the picked colour. A near-grey pick (chroma under neutral_below) is neutral on purpose.
//   3. A derived colour is always inside the sRGB gamut (chroma is reduced until it fits), so no browser clips it.

import rules from './tint-rules.json' with { type: 'json' };

export type TintRules = typeof rules;
export type Oklch = { l: number; c: number; h: number };

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** sRGB (0..1 each) to OKLCH. */
export function oklchOfRgb(r: number, g: number, b: number): Oklch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

/** OKLCH to linear sRGB (may fall outside 0..1). */
export function linearRgbOf({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
}

const inGamut = (color: Oklch) => linearRgbOf(color).every((v) => v >= -0.0001 && v <= 1.0001);

/** The largest chroma at or under `limit` that stays inside sRGB at this lightness and hue. */
export function fitChroma(l: number, h: number, limit: number): number {
  if (inGamut({ l, c: limit, h })) return limit;
  let low = 0; let high = limit;
  for (let step = 0; step < 24; step += 1) { const mid = (low + high) / 2; if (inGamut({ l, c: mid, h })) low = mid; else high = mid; }
  return low;
}

export function parseHex(text: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text).trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((ch) => ch + ch).join('') : hex;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number];
}

/** WCAG relative luminance contrast of two OKLCH colours (through sRGB). */
export function contrastOf(first: Oklch, second: Oklch): number {
  const luminance = (color: Oklch) => { const [r, g, b] = linearRgbOf(color).map((v) => Math.min(1, Math.max(0, v))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const round = (value: number, places: number) => Number(value.toFixed(places));

/**
 * The token changes for a picked colour in a scheme: { <token key>: 'oklch(L C H)' } (and `hue`, `neutral` for the caller to
 * show). Throws with plain words for a colour or scheme it cannot read.
 */
export function tintLook(colour: string, scheme: string, tintRules: TintRules = rules): { changes: Record<string, string>; hue: number | null; neutral: boolean } {
  if (!tintRules.schemes.includes(scheme)) throw new Error(tintRules.words.bad_scheme.replace('{schemes}', tintRules.schemes.join(', ')));
  const rgb = parseHex(colour);
  if (!rgb) throw new Error(tintRules.words.bad_colour);
  const picked = oklchOfRgb(...rgb);
  const neutral = picked.c < tintRules.neutral_below;
  const changes: Record<string, string> = {};
  for (const role of tintRules.roles) {
    const row = (role as unknown as Record<string, { lightness: number; chroma_max: number }>)[scheme];
    const chroma = neutral ? 0 : fitChroma(row.lightness, picked.h, row.chroma_max);
    changes[role.token] = `oklch(${round(row.lightness, 3)} ${round(chroma, 4)} ${neutral ? 0 : round(picked.h, 1)})`;
  }
  return { changes, hue: neutral ? null : round(picked.h, 1), neutral };
}
