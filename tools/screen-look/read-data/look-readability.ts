// parts/screen-look/read-data/look-readability.ts
//
// PURPOSE
//   Whether a look's own colours stay readable: each pair in parts/screen-look/look-readability.json (a text token, the ground
//   it is read on, the least contrast) is measured on the look's token values. A look made by hand, imported from a file or
//   taken from the shelf passes the same measure, so a colour from outside is never trusted to be readable.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and blind: no page, no records, no clock, no look or colour named here; pairs, floors and words are the DATA.
//   2. A pair whose token is missing, or not a plain colour, is not measured (it says nothing), never counted as a miss.
//   3. Measuring never changes a look; what to do with a miss (say it, or refuse a publish) is the caller's, from the DATA.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { colourOf, contrast } from './look-scheme.ts';

export interface ReadabilityPair { readonly text: string; readonly ground: string; readonly least_contrast: number; readonly says: string }
export interface ReadabilityData { readonly refuse_publish: boolean; readonly pairs: readonly ReadabilityPair[] }
export interface ReadabilityMiss { readonly text: string; readonly ground: string; readonly contrast: number; readonly least_contrast: number; readonly says: string }

/** The pairs of a look that miss their floor: [] when it is readable everywhere it can be measured. */
export function readabilityMisses(tokens: readonly { key: string; value: string | number }[], data: ReadabilityData): ReadabilityMiss[] {
  const byKey = new Map(tokens.map(token => [token.key, typeof token.value === 'string' ? token.value : undefined]));
  const misses: ReadabilityMiss[] = [];
  for (const pair of data.pairs) {
    const text = colourOf(byKey.get(pair.text));
    const ground = colourOf(byKey.get(pair.ground));
    if (!text || !ground) continue;
    const measured = Math.round(contrast(text, ground) * 100) / 100;
    if (measured < pair.least_contrast) misses.push({ text: pair.text, ground: pair.ground, contrast: measured, least_contrast: pair.least_contrast, says: pair.says });
  }
  return misses;
}

/** The misses said in plain words, or '' when there are none. */
export const sayReadability = (misses: readonly ReadabilityMiss[]): string =>
  misses.map(miss => `${miss.says} reads at ${miss.contrast}:1, under the ${miss.least_contrast}:1 it needs.`).join(' ');
