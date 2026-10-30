/**
 * file: packages/media-composition/do-work/choose-by-threshold.mjs
 *
 * PURPOSE: The one way this package writes an ffmpeg expression that picks one of several pieces by where a value
 * falls between sorted thresholds (a crop that follows a person through 550 track points, a censor path, a moving
 * vignette). It nests the choice as a balanced tree, so the expression is log2(n) levels deep instead of n.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Same answer as the chain if(lt(v,b0),p0,if(lt(v,b1),p1,...,pN)): piece i is chosen when b[i-1] <= v < b[i],
 *    piece 0 below b[0] and the last piece at or after the last threshold.
 * 2. Depth grows as log2(n). ffmpeg's expression parser refuses nesting past about 100 levels ("Missing ')' or too
 *    many args"), so a chain stops working near 100 points, which is under 13 seconds of a 0.125 s track.
 * 3. `thresholds` are sorted ascending and `pieces.length === thresholds.length + 1`; the caller escapes nothing
 *    but passes the separator it needs (`,` or `\\,` inside a filtergraph).
 */
export function chooseByThreshold(value, thresholds, pieces, separator = ',') {
  if (pieces.length !== thresholds.length + 1) throw new Error('[choose-by-threshold] needs one more piece than thresholds');
  const pick = (lo, hi) => {
    if (lo === hi) return String(pieces[lo]);
    const mid = (lo + hi) >> 1;
    return `if(lt(${value}${separator}${thresholds[mid]})${separator}${pick(lo, mid)}${separator}${pick(mid + 1, hi)})`;
  };
  return pick(0, thresholds.length);
}
