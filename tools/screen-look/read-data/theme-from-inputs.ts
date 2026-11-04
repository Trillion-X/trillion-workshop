// parts/screen-look/read-data/theme-from-inputs.ts
//
// PURPOSE
//   A whole look from three inputs a person can pick: the page colour (base), the action colour (accent) and how strong the
//   contrast is. Every colour-bearing token is derived in OKLCH (parts/screen-look/theme-inputs.json rows) and written as #rrggbb, pulled inside the
//   sRGB gamut and then held to contrast floors, so a look made from any three picks is readable. The answer is a `changes`
//   object for changeScreenLookTokens (screen-look-record.ts), so the look owner still validates every value it writes.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and blind: it names no look and no colour; roles, lightness lines, chroma limits and floors are DATA.
//   2. Scheme follows the base: a base darker than dark_below_lightness makes a dark look, otherwise a light one.
//   3. Ink is moved away from its ground until its floor holds; a floor that cannot hold (contrast pinned at the extreme)
//      is reported in `unmet`, never hidden.
//   4. Colour arithmetic is tint-look.ts's (one OKLCH implementation); this file only decides which lightness and chroma.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import data from '../theme-inputs.json' with { type: 'json' };
import { contrastOf, fitChroma, linearRgbOf, oklchOfRgb, parseHex, type Oklch } from './tint-look.ts';

export type ThemeInputsData = typeof data;
export interface ThemeInputs { readonly base: string; readonly accent: string; readonly contrast?: number }
export interface ThemeFloorMiss { readonly text: string; readonly ground: string; readonly contrast: number; readonly least_contrast: number }
export interface ThemeFromInputs { readonly scheme: 'light' | 'dark'; readonly changes: Record<string, string>; readonly unmet: readonly ThemeFloorMiss[] }

const INPUTS = ['base', 'accent', 'contrast'];
const fill = (words: string, values: Record<string, string | number>) => words.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const round = (value: number, places: number) => Number(value.toFixed(places));

type SchemeRow = { lightness: [number, number]; chroma_max: number; chroma_min?: number };
type Role = { id: string; tokens: string[]; from: 'base' | 'accent'; light: SchemeRow; dark: SchemeRow };

// A colour as #rrggbb: the look resolver derives hovers, glass and focus rings from plain hex or rgb() values only, so a
// generated colour is written the way those derivations can read it (fitChroma keeps it inside sRGB, so nothing clips).
function hexOf(colour: Oklch): string {
  const encode = (v: number) => { const c = Math.min(1, Math.max(0, v)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
  return `#${linearRgbOf(colour).map(v => Math.round(encode(v) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Moves `text` away from `ground` until `least` holds: first the way it already leans, else the other way. Null when neither reaches it. */
function heldAgainst(text: Oklch, ground: Oklch, least: number, step: number): Oklch | null {
  const lean = text.l >= ground.l ? 1 : -1;
  for (const direction of [lean, -lean]) {
    let held = text;
    while (contrastOf(held, ground) < least && held.l > 0 && held.l < 1) {
      const l = Math.min(1, Math.max(0, held.l + direction * step));
      held = { l, c: held.c === 0 ? 0 : fitChroma(l, held.h, held.c), h: held.h };
    }
    if (contrastOf(held, ground) >= least) return held;
  }
  return null;
}

/** The token changes for three picks: { <token key>: '#rrggbb' } with the scheme and any floor that could not hold.
 *  Throws with plain words for a colour or a contrast it cannot read. */
export function themeFromInputs(inputs: Record<string, unknown>, rules: ThemeInputsData = data): ThemeFromInputs {
  const { words } = rules;
  const unknown = Object.keys(inputs).filter(name => !INPUTS.includes(name));
  if (unknown.length) throw new Error(fill(words.unknown, { names: unknown.join(', '), inputs: INPUTS.join(', ') }));
  const picked: Record<'base' | 'accent', Oklch> = { base: { l: 0, c: 0, h: 0 }, accent: { l: 0, c: 0, h: 0 } };
  for (const name of ['base', 'accent'] as const) {
    const given = inputs[name];
    if (given === undefined) throw new Error(fill(words.missing, { inputs: 'base, accent' }));
    const rgb = typeof given === 'string' ? parseHex(given) : null;
    if (!rgb) throw new Error(fill(words.bad_colour, { input: name }));
    picked[name] = oklchOfRgb(...rgb);
  }
  const contrast = inputs.contrast === undefined ? rules.contrast.default : Number(inputs.contrast);
  if (!Number.isFinite(contrast) || contrast < rules.contrast.min || contrast > rules.contrast.max) {
    throw new Error(fill(words.bad_contrast, { min: rules.contrast.min, max: rules.contrast.max }));
  }
  const along = (contrast - rules.contrast.min) / (rules.contrast.max - rules.contrast.min);
  const scheme = picked.base.l < rules.dark_below_lightness ? 'dark' : 'light';
  const roles = rules.roles as unknown as Role[];

  const colours = new Map<string, Oklch>();
  for (const role of roles) {
    const row = role[scheme];
    const pick = picked[role.from];
    const lightness = row.lightness[0] + (row.lightness[1] - row.lightness[0]) * along;
    const wanted = pick.c < rules.neutral_below ? 0 : Math.min(Math.max(pick.c, row.chroma_min ?? 0), row.chroma_max);
    const hue = wanted === 0 ? 0 : pick.h;
    colours.set(role.id, { l: lightness, c: wanted === 0 ? 0 : fitChroma(lightness, hue, wanted), h: hue });
  }

  const unmet: ThemeFloorMiss[] = [];
  for (const floor of rules.floors) {
    const text = colours.get(floor.text);
    const ground = colours.get(floor.ground);
    if (!text || !ground) continue;
    const held = heldAgainst(text, ground, floor.least_contrast, rules.step);
    if (held) colours.set(floor.text, held);
    else unmet.push({ text: floor.text, ground: floor.ground, contrast: round(contrastOf(text, ground), 2), least_contrast: floor.least_contrast });
  }

  const changes: Record<string, string> = {};
  for (const role of roles) for (const token of role.tokens) changes[token] = hexOf(colours.get(role.id)!);
  return { scheme, changes, unmet };
}

/** The changes for `theme` from three picks, kept to the tokens the look has (a token it lacks is skipped, not an error). */
export function themeChangesFor(theme: { readonly tokens: readonly { readonly key: string }[] }, inputs: Record<string, unknown>): ThemeFromInputs {
  const made = themeFromInputs(inputs);
  const have = new Set(theme.tokens.map(token => token.key));
  return { ...made, changes: Object.fromEntries(Object.entries(made.changes).filter(([key]) => have.has(key))) };
}
