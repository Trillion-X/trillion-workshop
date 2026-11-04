// =============================================================================
// parts/screen-look/read-data/see-through.ts
//
// Purpose: a worn look's values (CSS variable to value) with its surface colours made see-through enough for what is
// behind the whole page to show, while its words stay readable (see-through.json).
//
// Invariants:
// - Blind: knows no look, no screen and nothing about what is behind; the variables are DATA.
// - Words first: a surface covers just enough that `words` keeps `least_contrast` over it whatever shows behind it,
//   judged over black and white behind (the brightness extremes, so everything between reads at least as well).
// - Pure: same values in, same values out; nothing is written.
// =============================================================================

import settings from '../see-through.json' with { type: 'json' };
import { colourOf, contrast, over, type Rgba } from './look-over-time.ts';

export const SEE_THROUGH = settings as {
  grounds: string[]; words: string; least_contrast: number; least_see_through: number; step: number; behind_blur_px: number;
};

const BLACK: Rgba = [0, 0, 0, 1];
const WHITE: Rgba = [255, 255, 255, 1];
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The least cover (0 to 1) of `ground` over anything behind it that keeps `words` readable on it, never more than
 *  `1 - least_see_through`. */
export function leastCover(ground: Rgba, words: Rgba, least = SEE_THROUGH.least_contrast): number {
  const most = 1 - SEE_THROUGH.least_see_through;
  for (let cover = 0; cover < most; cover += SEE_THROUGH.step) {
    const readable = [BLACK, WHITE].every(behind => {
      const shown = over([ground[0], ground[1], ground[2], cover], behind);
      return contrast(over(words, shown), shown) >= least;
    });
    if (readable) return round(cover);
  }
  return round(most);
}

/** The variable the page backdrop reads its blur from. */
export const PAGE_BACKDROP_BLUR = '--page-backdrop-blur';

/** `values` with each ground colour made see-through by its least cover and the page backdrop's blur set; values that
 *  are not colours stay as they are. */
export function seeThroughValues(values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...values, [PAGE_BACKDROP_BLUR]: `${SEE_THROUGH.behind_blur_px}px` };
  const words = colourOf(values[SEE_THROUGH.words]);
  if (!words) return out;
  for (const key of SEE_THROUGH.grounds) {
    const ground = colourOf(values[key]);
    if (!ground) continue;
    const cover = round(leastCover(ground, words) * ground[3]);
    out[key] = `rgba(${Math.round(ground[0])}, ${Math.round(ground[1])}, ${Math.round(ground[2])}, ${cover})`;
  }
  return out;
}
