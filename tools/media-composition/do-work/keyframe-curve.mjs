// How a keyframe span moves from its start value to its end value. A curve is a row of
// keyframe-curves.json: the share of the way, as polynomial coefficients in the span fraction F.
// The ffmpeg expression compiler and the numeric sampler both read the same row, so a curve is
// never written twice and a new one is a new row.
import CURVES from './keyframe-curves.json' with { type: 'json' };

/** The coefficients the curve row `name` holds; refuses a name no row has. */
export function curveOf(name, where = 'keyframe') {
  const coefficients = Object.hasOwn(CURVES.curves, name) ? CURVES.curves[name] : undefined;
  if (!coefficients) throw new Error(`[${where}] interp ${JSON.stringify(name)} not in ${JSON.stringify(Object.keys(CURVES.curves))}`);
  return coefficients;
}

/** True when the curve never leaves its start value (every coefficient is 0). */
export function staysAtStart(coefficients) {
  return coefficients.every((c) => c === 0);
}

/** The share of the way at span fraction `f` (a number). */
export function shareAt(coefficients, f) {
  return coefficients.reduceRight((sum, c) => sum * f + c, 0);
}

/**
 * The share of the way as an ffmpeg expression of the fraction expression `F`. A one-term curve
 * F^1 is `F` itself, so a linear span keeps its plain form.
 */
export function shareExpr(coefficients, F) {
  const terms = coefficients
    .map((c, power) => ({ c, power }))
    .filter(({ c, power }) => c !== 0 && power > 0);
  if (terms.length === 1 && terms[0].c === 1 && terms[0].power === 1 && coefficients[0] === 0) return F;
  const parts = [];
  if (coefficients[0] !== 0) parts.push(String(coefficients[0]));
  for (const { c, power } of terms) {
    const factor = Array.from({ length: power }, () => `(${F})`).join('*');
    const size = Math.abs(c) === 1 ? factor : `${Math.abs(c)}*${factor}`;
    parts.push(parts.length === 0 ? (c < 0 ? `-${size}` : size) : `${c < 0 ? '-' : '+'}${size}`);
  }
  return `(${parts.join('') || '0'})`;
}
