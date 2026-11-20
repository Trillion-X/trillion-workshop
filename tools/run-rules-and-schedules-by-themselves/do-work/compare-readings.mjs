// src/compare-readings.mjs
//
// Purpose: say which of a reading's numbers got worse than the reading before (tool:say-what-got-worse, a Workshop tool
// that runs in this Worker). A schedule or workflow reads something twice over (this period and the one before, or
// today's answer and the kept one), hands both here, and tells the person only when `worse` is true. Nothing is kept.
//
// Non-Negotiable Invariants:
//   1. A measure's `now` and `before` are a number, a list of numbers (summed) or a list of items, each item's number
//      at `value` (summed) and, with `key`, named by the value at that path, so a total also says which parts moved.
//   2. A missing value is unknown unless the measure says `missing: "zero"` (a count, where nothing found means none);
//      a measure with an unknown side is never worse, and says what it could not compare.
//   3. A change smaller than `at_least` is not worse. `worse_when` is "higher" or "lower"; nothing else is accepted.
//   4. Nothing here names a reading, a service or a unit: every measure is the caller's DATA.
//
// Shape
//   sayWhatGotWorse({ measures: [{ label, now, before, worse_when, value?, key?, missing?, at_least?, scale?, unit? }] })
//     -> { worse, measures: [{ label, now, before, change, worse, parts? }], lines, said }
//   `scale` divides both numbers before they are shown and compared (microseconds to seconds: 1000000).
//

export class CompareReadingsError extends Error {}

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const at = (item, path) => (Array.isArray(path) ? path : [path]).reduce((from, part) => (from == null ? undefined : from[part]), item);
const shown = value => (Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100));
const named = key => (key.length > 16 ? `${key.slice(0, 12)}…` : key);

// One side of a measure: its total (or null when unknown) and, with key, its total per part.
function side(value, measure) {
  if (value === undefined || value === null) return measure.missing === 'zero' ? { total: 0, parts: new Map() } : { total: null, parts: new Map() };
  if (typeof value === 'number') return { total: value, parts: new Map() };
  if (!Array.isArray(value)) throw new CompareReadingsError(`${measure.label}: now and before are a number or a list.`);
  const parts = new Map();
  let total = 0;
  for (const item of value) {
    const number = Number(typeof item === 'number' ? item : at(item, measure.value));
    if (!Number.isFinite(number)) continue;
    total += number;
    if (measure.key !== undefined && object(item)) {
      const key = String(at(item, measure.key) ?? '');
      parts.set(key, (parts.get(key) ?? 0) + number);
    }
  }
  return { total: !value.length && measure.missing !== 'zero' ? null : total, parts };
}

function compared(measure) {
  if (!object(measure) || typeof measure.label !== 'string' || !measure.label.trim()) throw new CompareReadingsError('Each measure needs a label.');
  if (measure.worse_when !== 'higher' && measure.worse_when !== 'lower') throw new CompareReadingsError(`${measure.label}: worse_when is "higher" or "lower".`);
  const scale = Number(measure.scale) > 0 ? Number(measure.scale) : 1;
  const unit = typeof measure.unit === 'string' && measure.unit ? ` ${measure.unit}` : '';
  const now = side(measure.now, measure);
  const before = side(measure.before, measure);
  const scaled = total => (total === null ? null : total / scale);
  const [n, b] = [scaled(now.total), scaled(before.total)];
  if (n === null || b === null) {
    return { row: { label: measure.label, now: n, before: b, change: null, worse: false }, line: `${measure.label}: not compared, ${n === null ? 'nothing was read now' : 'nothing was read before'}.` };
  }
  const change = n - b;
  const worse = Math.abs(change) >= (Number(measure.at_least) || Number.MIN_VALUE) && (measure.worse_when === 'higher' ? change > 0 : change < 0);
  const moved = [...new Set([...now.parts.keys(), ...before.parts.keys()])]
    .map(key => ({ key, now: (now.parts.get(key) ?? 0) / scale, before: (before.parts.get(key) ?? 0) / scale }))
    .filter(part => part.now !== part.before)
    .sort((x, y) => Math.abs(y.now - y.before) - Math.abs(x.now - x.before));
  const line = `${measure.label}: ${shown(n)}${unit} (${shown(b)}${unit} before)${moved.length ? `; ${moved.slice(0, 3).map(part => `${named(part.key)} ${shown(part.now)} (${shown(part.before)})`).join(', ')}` : ''}.`;
  return { row: { label: measure.label, now: n, before: b, change, worse, ...(moved.length ? { parts: moved } : {}) }, line };
}

/** Which measures got worse than before, and the whole reading in words. */
export function sayWhatGotWorse(input) {
  if (!object(input) || !Array.isArray(input.measures) || !input.measures.length) throw new CompareReadingsError('Give measures: a list of { label, now, before, worse_when }.');
  const results = input.measures.map(compared);
  const worse = results.some(result => result.row.worse);
  const lines = results.map(result => result.line);
  const worseLabels = results.filter(result => result.row.worse).map(result => result.row.label);
  return {
    worse,
    measures: results.map(result => result.row),
    lines,
    said: worse ? `Worse than before: ${worseLabels.join(', ')}. ${lines.join(' ')}` : `Nothing got worse. ${lines.join(' ')}`,
  };
}
