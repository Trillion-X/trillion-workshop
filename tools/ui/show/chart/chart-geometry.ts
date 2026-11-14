// parts/ui/show/chart/chart-geometry.ts
//
// PURPOSE
//   The pure geometry of every chart Trillion draws: rounded ticks a person reads at a glance, linear scales, a smooth
//   line that never overshoots its points (monotone cubic, Fritsch-Carlson, the curve shadcn and Recharts call
//   'monotone'), stacked layers, donut arcs, steps of one hue for a heat map, and which slot the pointer is over.
//   Nothing here draws, reads a record or knows what a number means; Chart.tsx and the marks call it with numbers.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure functions of their arguments: same numbers in, same numbers out, no clocks, no DOM.
//   2. A missing value (null) is a gap, never zero: a line breaks there and a stack skips it.
//   3. A flat or empty domain still answers a usable range (0 to 1 around the value), never a divide by zero.
//   4. Ticks are "nice" (1, 2, 2.5 or 5 times a power of ten) and always include the domain.
//
//   The ways a line bends between its points are an open map (registerChartCurve): monotone, linear and step ship;
//   a curve nobody registered draws as monotone, never nothing.
//
// Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui, Apache-2.0, commit acdc998c): registry/charts/depth-chart.tsx (step path), radar-chart.tsx (polar grid), market-heatmap.tsx (tile layout); changes: pure functions with no recharts, tiles laid out by the squarified rule, curves in an open map.
//
// The curve math follows Fritsch & Carlson (1980), "Monotone Piecewise Cubic Interpolation", the same tangent rule
// d3-shape's curveMonotoneX implements (ISC); written here from the paper, no code copied.

export type Domain = readonly [number, number];

const STEPS = [1, 2, 2.5, 5, 10];

/** Rounded ticks covering [min, max], about `count` of them. A domain touching zero keeps zero as a tick. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  let lo = Math.min(min, max), hi = Math.max(min, max);
  if (lo === hi) { if (lo === 0) hi = 1; else if (lo > 0) lo = 0; else hi = 0; }
  const raw = (hi - lo) / Math.max(1, count);
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = (STEPS.find(candidate => candidate * power >= raw) ?? 10) * power;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

/** A linear map from a domain to a pixel range. */
export function linear([d0, d1]: Domain, [r0, r1]: Domain): (value: number) => number {
  const span = d1 - d0 || 1;
  return value => r0 + ((value - d0) / span) * (r1 - r0);
}

/** The value domain of some series (numbers, nulls ignored), including zero when `fromZero`. */
export function extent(values: readonly (number | null | undefined)[], fromZero = true): Domain {
  let lo = fromZero ? 0 : Infinity, hi = fromZero ? 0 : -Infinity;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  return [lo, hi];
}

export type Point = { x: number; y: number };

/** The tangent at each point of a run so the curve stays between neighbouring points (monotone in y). */
function monotoneTangents(points: readonly Point[]): number[] {
  const n = points.length;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1].x - points[i].x;
    slopes.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx);
  }
  const tangents = new Array<number>(n);
  tangents[0] = slopes[0] ?? 0;
  tangents[n - 1] = slopes[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i += 1) {
    const a = slopes[i - 1], b = slopes[i];
    if (a * b <= 0) { tangents[i] = 0; continue; }
    const h0 = points[i].x - points[i - 1].x, h1 = points[i + 1].x - points[i].x;
    // The weighted harmonic mean of the two slopes (Fritsch-Butland), which keeps the cubic inside both intervals.
    tangents[i] = (3 * (h0 + h1)) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / b);
  }
  return tangents;
}

/** A curve: the path through a run of points, starting with its "M". Use only L and C segments after the head. */
export type ChartCurve = (points: readonly Point[]) => string;

const head = (point: Point) => `M${round(point.x)},${round(point.y)}`;

const linearCurve: ChartCurve = points => head(points[0]) + points.slice(1).map(p => `L${round(p.x)},${round(p.y)}`).join('');

const monotoneCurve: ChartCurve = points => {
  if (points.length <= 2) return linearCurve(points);
  const m = monotoneTangents(points);
  let d = head(points[0]);
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i], p1 = points[i + 1];
    const h = (p1.x - p0.x) / 3;
    d += `C${round(p0.x + h)},${round(p0.y + m[i] * h)},${round(p1.x - h)},${round(p1.y - m[i + 1] * h)},${round(p1.x)},${round(p1.y)}`;
  }
  return d;
};

/** Holds each value until the next slot, then steps: the way a book of orders or a price that changes in jumps reads. */
const stepCurve: ChartCurve = points => {
  let d = head(points[0]);
  for (let i = 1; i < points.length; i += 1) d += `L${round(points[i].x)},${round(points[i - 1].y)}L${round(points[i].x)},${round(points[i].y)}`;
  return d;
};

/** Steps first, then holds: a value counts from the slot before it (the bids of a book, whose total grows toward lower prices). */
const stepBeforeCurve: ChartCurve = points => {
  let d = head(points[0]);
  for (let i = 1; i < points.length; i += 1) d += `L${round(points[i - 1].x)},${round(points[i].y)}L${round(points[i].x)},${round(points[i].y)}`;
  return d;
};

const CURVES = new Map<string, ChartCurve>([['monotone', monotoneCurve], ['linear', linearCurve], ['step', stepCurve], ['step-before', stepBeforeCurve]]);

/** Adds a curve to every line, area and sparkline. Registering an id again replaces it. */
export const registerChartCurve = (id: string, curve: ChartCurve) => { CURVES.set(id, curve); };
/** The curves a person can pick, by id. */
export const chartCurves = () => [...CURVES.keys()];
/** The curve for an id; `true` and an id nobody registered are monotone, `false` is linear. */
export const chartCurve = (id: string | boolean | undefined): ChartCurve =>
  id === false ? linearCurve : (typeof id === 'string' ? CURVES.get(id) : undefined) ?? monotoneCurve;

/** One path through a run of points, bent by `curve` (a curve id, or a boolean: `false` draws straight segments). */
export function runPath(points: readonly Point[], curve: string | boolean = true): string {
  if (!points.length) return '';
  if (points.length === 1) return head(points[0]);
  return chartCurve(curve)(points);
}

/** The runs of a series between its gaps: each run is the indices of consecutive filled values. */
export function runsOf(values: readonly (number | null | undefined)[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((value, index) => {
    if (typeof value === 'number' && Number.isFinite(value)) run.push(index);
    else if (run.length) { runs.push(run); run = []; }
  });
  if (run.length) runs.push(run);
  return runs;
}

/** A line's path and the filled area under it (down to `baseY`, or to `lower` for a stacked layer), run by run. */
export function linePaths(xs: readonly number[], ys: readonly (number | null)[], baseY: number, curve: string | boolean = true, lower?: readonly (number | null)[]): { line: string; area: string } {
  const line: string[] = [], area: string[] = [];
  for (const run of runsOf(ys)) {
    const top = run.map(index => ({ x: xs[index], y: ys[index] as number }));
    line.push(runPath(top, curve));
    if (lower) {
      const bottom = run.slice().reverse().map(index => ({ x: xs[index], y: (lower[index] ?? baseY) as number }));
      area.push(`${runPath(top, curve)}L${round(bottom[0].x)},${round(bottom[0].y)}${runPath(bottom, curve).replace(/^M[^C L]+/, '')}Z`);
    } else {
      const first = top[0], last = top[top.length - 1];
      area.push(`${runPath(top, curve)}L${round(last.x)},${round(baseY)}L${round(first.x)},${round(baseY)}Z`);
    }
  }
  return { line: line.join(''), area: area.join('') };
}

/** Stacked layers: for each series, its lower and upper value at each slot (a null value adds nothing there). */
export function stack(series: readonly (readonly (number | null)[])[]): { lower: (number | null)[]; upper: (number | null)[] }[] {
  const slots = Math.max(0, ...series.map(values => values.length));
  const positive = new Array<number>(slots).fill(0);
  const negative = new Array<number>(slots).fill(0);
  return series.map(values => {
    const lower: (number | null)[] = [], upper: (number | null)[] = [];
    for (let i = 0; i < slots; i += 1) {
      const value = values[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) { lower.push(null); upper.push(null); continue; }
      const base = value >= 0 ? positive : negative;
      lower.push(base[i]); base[i] += value; upper.push(base[i]);
    }
    return { lower, upper };
  });
}

/** The x centre of each of `count` slots across [left, right]. */
export function slotCentres(count: number, left: number, right: number, edge: 'band' | 'point'): { centres: number[]; slot: number } {
  if (count <= 0) return { centres: [], slot: 0 };
  if (edge === 'point') {
    if (count === 1) return { centres: [(left + right) / 2], slot: right - left };
    const slot = (right - left) / (count - 1);
    return { centres: Array.from({ length: count }, (_, i) => left + i * slot), slot };
  }
  const slot = (right - left) / count;
  return { centres: Array.from({ length: count }, (_, i) => left + slot * (i + 0.5)), slot };
}

/**
 * The x of each slot placed by its position on a numeric axis (a price), across [left, right]. With a `mid`, `gap` pixels are
 * kept open there so the two sides never touch, and the middle of the gap is returned as `midX`. `slot` is the average
 * spacing, for the things sized by it (labels, the hover band).
 */
export function valueCentres(ats: readonly number[], left: number, right: number, mid?: number, gap = 0): { centres: number[]; slot: number; midX: number | null } {
  if (!ats.length) return { centres: [], slot: 0, midX: null };
  const low = Math.min(...ats, mid ?? Infinity), high = Math.max(...ats, mid ?? -Infinity);
  const open = mid === undefined ? 0 : Math.min(gap, Math.max(0, right - left) / 2);
  const scale = high > low ? (right - left - open) / (high - low) : 0;
  const centres = ats.map(at => (high > low ? left + (at - low) * scale + (mid !== undefined && at > mid ? open : 0) : (left + right) / 2));
  return { centres, slot: ats.length > 1 ? (right - left) / (ats.length - 1) : right - left, midX: mid === undefined ? null : left + (mid - low) * scale + open / 2 };
}

/** Which slot centre is nearest to x. */
export function nearestIndex(centres: readonly number[], x: number): number {
  let best = 0, distance = Infinity;
  for (let i = 0; i < centres.length; i += 1) {
    const d = Math.abs(centres[i] - x);
    if (d < distance) { distance = d; best = i; }
  }
  return best;
}

/** A rectangle with its two ends at `radius` on the side away from the baseline (the bar's data end only). */
export function barPath(x: number, y0: number, width: number, y1: number, radius: number): string {
  const up = y1 < y0;
  const height = Math.abs(y1 - y0);
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const top = up ? y1 : y0, bottom = up ? y0 : y1;
  if (r === 0) return `M${round(x)},${round(top)}h${round(width)}v${round(height)}h${round(-width)}Z`;
  if (up) return `M${round(x)},${round(bottom)}V${round(top + r)}Q${round(x)},${round(top)},${round(x + r)},${round(top)}H${round(x + width - r)}Q${round(x + width)},${round(top)},${round(x + width)},${round(top + r)}V${round(bottom)}Z`;
  return `M${round(x)},${round(top)}V${round(bottom - r)}Q${round(x)},${round(bottom)},${round(x + r)},${round(bottom)}H${round(x + width - r)}Q${round(x + width)},${round(bottom)},${round(x + width)},${round(bottom - r)}V${round(top)}Z`;
}

/** One donut slice from angle a0 to a1 (radians, 0 at twelve o'clock, clockwise), between two radii. */
export function arcPath(cx: number, cy: number, inner: number, outer: number, a0: number, a1: number): string {
  const sweep = a1 - a0;
  if (sweep >= Math.PI * 2 - 1e-6) {
    // A whole ring is two halves, since one arc cannot end where it starts.
    return `${arcPath(cx, cy, inner, outer, a0, a0 + Math.PI)}${arcPath(cx, cy, inner, outer, a0 + Math.PI, a0 + Math.PI * 2)}`;
  }
  const at = (radius: number, angle: number) => `${round(cx + radius * Math.sin(angle))},${round(cy - radius * Math.cos(angle))}`;
  const large = sweep > Math.PI ? 1 : 0;
  return `M${at(outer, a0)}A${round(outer)},${round(outer)},0,${large},1,${at(outer, a1)}L${at(inner, a1)}A${round(inner)},${round(inner)},0,${large},0,${at(inner, a0)}Z`;
}

/** The angles of each share of a whole, with `gap` radians left between neighbours (none for a single share). */
export function arcAngles(values: readonly number[], gap = 0): { a0: number; a1: number }[] {
  const shown = values.map(value => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = shown.reduce((sum, value) => sum + value, 0);
  const filled = shown.filter(value => value > 0).length;
  if (!total) return shown.map(() => ({ a0: 0, a1: 0 }));
  const usable = Math.PI * 2 - (filled > 1 ? gap * filled : 0);
  let angle = 0;
  return shown.map(value => {
    if (!value) return { a0: angle, a1: angle };
    const a0 = angle + (filled > 1 ? gap / 2 : 0);
    const a1 = a0 + (value / total) * usable;
    angle = a1 + (filled > 1 ? gap / 2 : 0);
    return { a0, a1 };
  });
}

/** Thresholds splitting the filled values into `steps` steps of a heat map (equal shares of the range, rounded). */
export function heatThresholds(values: readonly (number | null)[], steps = 4): number[] {
  const filled = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (!filled.length) return [];
  const max = Math.max(...filled);
  const ticks = niceTicks(0, max, steps);
  return ticks.slice(1, steps);
}

/** Which step (0 for nothing, 1..n) a value falls in. */
export function heatStep(value: number | null | undefined, thresholds: readonly number[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  let step = 1;
  for (const threshold of thresholds) if (value > threshold) step += 1;
  return step;
}

/** A point at `radius` from the centre on `angle` (radians, 0 at twelve o'clock, clockwise). */
export function polar(cx: number, cy: number, radius: number, angle: number): Point {
  return { x: round(cx + radius * Math.sin(angle)), y: round(cy - radius * Math.cos(angle)) };
}

/** A closed straight-sided path through points. */
export function polygonPath(points: readonly Point[]): string {
  return points.length ? `${points.map((p, at) => `${at ? 'L' : 'M'}${round(p.x)},${round(p.y)}`).join('')}Z` : '';
}

export type Tile = { index: number; x: number; y: number; w: number; h: number };

/**
 * Tiles for `values` filling w x h, each tile's area proportional to its value (the squarified rule: rows are filled
 * along the shorter side while the worst tile shape improves). Values that are not above zero get no tile.
 */
export function squarify(values: readonly (number | null | undefined)[], w: number, h: number): Tile[] {
  const items = values.map((value, index) => ({ index, value: typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0 }))
    .filter(item => item.value > 0).sort((a, b) => b.value - a.value);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const tiles: Tile[] = [];
  if (!total || w <= 0 || h <= 0) return tiles;
  let x = 0, y = 0, width = w, height = h;
  const scale = (w * h) / total;
  const worst = (row: typeof items, side: number) => {
    const area = row.reduce((sum, item) => sum + item.value * scale, 0);
    let low = Infinity, high = 0;
    for (const item of row) { const a = item.value * scale; low = Math.min(low, a); high = Math.max(high, a); }
    return Math.max((side * side * high) / (area * area), (area * area) / (side * side * low));
  };
  const place = (row: typeof items) => {
    const area = row.reduce((sum, item) => sum + item.value * scale, 0);
    if (width >= height) {
      const rowWidth = area / height;
      let at = y;
      for (const item of row) { const each = (item.value * scale) / rowWidth; tiles.push({ index: item.index, x, y: at, w: rowWidth, h: each }); at += each; }
      x += rowWidth; width -= rowWidth;
    } else {
      const rowHeight = area / width;
      let at = x;
      for (const item of row) { const each = (item.value * scale) / rowHeight; tiles.push({ index: item.index, x: at, y, w: each, h: rowHeight }); at += each; }
      y += rowHeight; height -= rowHeight;
    }
  };
  let row: typeof items = [];
  for (const item of items) {
    const side = Math.min(width, height);
    if (!row.length || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else { place(row); row = [item]; }
  }
  if (row.length) place(row);
  return tiles;
}

const round = (value: number) => Math.round(value * 100) / 100;
