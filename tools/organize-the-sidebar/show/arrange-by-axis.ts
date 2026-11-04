// packages/group/show/arrange-by-axis.ts
//
// The arrange-by-AXIS leaf — pure, zero I/O, framework-agnostic. The CONTINUOUS sibling of
// arrange-by-field: where that buckets items into DISCRETE clusters by a string groupKey, this
// places items at CONTINUOUS pixel positions by a NUMERIC value per axis (a linear scale). ONE
// primitive → a whole family of board views by DATA alone (L069): a 1-D TIMELINE / number-line
// (X = date/score, Y = a fixed lane) and a 2-D SCATTER (X, Y = any two numerics — price x progress,
// effort x impact as a continuous plane). The caller precomputes each item's raw numeric from ANY
// field (date.getTime(), price, percent); this leaf is blind to that meaning and MUST NEVER
// enumerate a field kind (L090 — self-describing data, generic handler). Fail-closed: a null / NaN /
// degenerate value never yields a NaN coordinate — such items park in a visible no-value pile below
// the plot (onAxis:false), so the geometry is TOTAL and every input keeps exactly one placement.

import type { ArrangedPosition } from './arrange-by-field';
import { orderedClusterKeys } from './arrange-by-field';
import { finiteCoord } from '../read-data/finite-coord';

/** Sanitize an untrusted item dimension (persisted w/h): a `Number.MAX_VALUE`/`Infinity`/`NaN` would
 *  otherwise make `cx - it.w/2` a NaN/huge coordinate or overflow the pile accumulation to Infinity.
 *  finiteCoord bounds both non-finite and finite-huge; floored at 0 (a negative box is never real). */
const dim = (v: number): number => Math.max(0, finiteCoord(v));

export interface AxisItem {
  readonly memberId: string;
  readonly w: number;
  readonly h: number;
  /** Raw numeric on the X axis (date ms / price / score). null / non-finite → no X value. */
  readonly valueX: number | null;
  /** Raw numeric on the Y axis. Left off EVERY item → 1-D mode (timeline/number-line, Y = the fixed
   *  lane). null / non-finite on SOME items in 2-D mode → that item has no Y value (parks). */
  readonly valueY?: number | null;
}

/** A closed numeric interval — the DATA domain of one axis (the value range the pixels span). */
export interface AxisExtent {
  readonly min: number;
  readonly max: number;
}

export interface ArrangeByAxisOptions {
  readonly originX?: number; // pixel top-left of the plot area (default 0)
  readonly originY?: number; // (default 0)
  readonly spanX?: number; // pixel WIDTH of the X axis (default 800)
  readonly spanY?: number; // pixel HEIGHT of the Y axis (default 400); ignored in 1-D mode
  readonly domainX?: AxisExtent; // X data domain; omit → derived from the items' finite valueX
  readonly domainY?: AxisExtent; // Y data domain; omit → derived from the items' finite valueY
  readonly laneY?: number; // 1-D mode: the fixed Y CENTRE every item sits on (default originY)
  readonly invertY?: boolean; // screen Y grows DOWN; invert so a LARGER value sits HIGHER (default true)
  readonly noValueGap?: number; // gap below the plot where no-value items pile (default 48)
  readonly pileGap?: number; // horizontal gap between piled no-value items (default 16)
}

/** One placed item. Extends {@link ArrangedPosition} so it drops into the SAME apply-path as every
 *  other arranger; `onAxis:false` marks an item parked in the no-value pile (missing a required
 *  numeric), so a caller can dim/label it rather than pretend it has a real position. */
export interface AxisPlaced extends ArrangedPosition {
  readonly onAxis: boolean;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Linear scale value→pixel. Degenerate domain (span <= 0 — all values equal or bad) pins to the
 *  range START (never NaN, never divide-by-zero) — a single-valued axis collapses to one line. */
function linScale(value: number, domain: AxisExtent, rangeStart: number, rangeSpan: number): number {
  const d = domain.max - domain.min;
  // `domainX`/`domainY` are caller options, so a non-finite extent (min/max = ±Infinity) is
  // representable: it makes `d` Infinity/NaN and `(value - min) / d` = Infinity/Infinity = NaN.
  // `!(d > 0)` catches NaN and <= 0 but NOT Infinity → guard finiteness too (a non-finite extent
  // always makes `d` non-finite or <= 0, so this also implies min/max are finite here).
  if (!(d > 0) || !Number.isFinite(d)) return rangeStart;
  // Clamp the output: even with a finite domain, a finite-huge `value` (e.g. MAX_VALUE) against a small
  // domain makes `((value-min)/d)*rangeSpan` overflow to Infinity. finiteCoord bounds it to a real coord
  // (fallback to rangeStart on non-finite). A normal in-domain value is a byte-identical no-op.
  return finiteCoord(rangeStart + ((value - domain.min) / d) * rangeSpan, rangeStart);
}

/** Derive [min,max] over the finite values; null when NONE are finite (→ that axis has no domain,
 *  so nothing can be scaled on it and every item parks). */
function deriveExtent(values: readonly (number | null | undefined)[]): AxisExtent | null {
  let min = Infinity;
  let max = -Infinity;
  let any = false;
  for (const v of values) {
    if (isFiniteNum(v)) {
      any = true;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return any ? { min, max } : null;
}

/** The geometry-aware result of a plot: the placements PLUS the resolved domains + plot box, so a
 *  caller (e.g. the labelled bridge) can compute matching {@link axisTicks} without re-deriving the
 *  domain — one geometry pass is the SSOT for both the boxes and the axis furniture. */
export interface AxisPlot {
  readonly placed: AxisPlaced[];
  readonly domainX: AxisExtent | null; // null → nothing scaled on X (every item parked)
  readonly domainY: AxisExtent | null; // null → 1-D (no Y axis)
  readonly twoD: boolean;
  readonly originX: number;
  readonly originY: number;
  readonly spanX: number;
  readonly spanY: number;
  readonly laneY: number;
  readonly invertY: boolean;
}

/**
 * Place `items` at continuous pixel positions by their numeric axis value(s) AND report the resolved
 * geometry (domains + plot box). The core the whole family projects from. Empty input → an empty
 * plot at the resolved origin.
 *
 * MODE is decided by the DATA (L090 — no flag enum): 2-D SCATTER iff a Y domain exists (given via
 * `domainY` or derivable from any finite `valueY`); otherwise 1-D TIMELINE / number-line with every
 * item on the fixed `laneY`. Each box is CENTRED on its scaled coordinate (x = cx - w/2), so the
 * card sits ON its date/value, matching the circle strategy's centring.
 *
 * Fail-closed (SP5): an item missing a REQUIRED numeric (no X value, or in 2-D no Y value) is not
 * dropped and never gets a NaN coordinate — it parks in a left→right row in the no-value pile below
 * the plot with `onAxis:false`. `invertY` (default true) flips the Y range so a LARGER value sits
 * HIGHER on screen (the intuitive "up = more"). Deterministic: on-axis items keep input order,
 * then the pile follows in input order.
 */
export function axisPlot(items: readonly AxisItem[], opts?: ArrangeByAxisOptions): AxisPlot {
  const originX = isFiniteNum(opts?.originX) ? (opts as ArrangeByAxisOptions).originX! : 0;
  const originY = isFiniteNum(opts?.originY) ? (opts as ArrangeByAxisOptions).originY! : 0;
  const spanX = isFiniteNum(opts?.spanX) && (opts as ArrangeByAxisOptions).spanX! > 0 ? (opts as ArrangeByAxisOptions).spanX! : 800;
  const spanY = isFiniteNum(opts?.spanY) && (opts as ArrangeByAxisOptions).spanY! > 0 ? (opts as ArrangeByAxisOptions).spanY! : 400;
  const invertY = opts?.invertY ?? true;
  const laneY = isFiniteNum(opts?.laneY) ? (opts as ArrangeByAxisOptions).laneY! : originY;
  const noValueGap = isFiniteNum(opts?.noValueGap) && (opts as ArrangeByAxisOptions).noValueGap! >= 0 ? (opts as ArrangeByAxisOptions).noValueGap! : 48;
  const pileGap = isFiniteNum(opts?.pileGap) && (opts as ArrangeByAxisOptions).pileGap! >= 0 ? (opts as ArrangeByAxisOptions).pileGap! : 16;

  const domainX = opts?.domainX ?? deriveExtent(items.map((i) => i.valueX));
  const domainY = opts?.domainY ?? deriveExtent(items.map((i) => i.valueY));
  const twoD = domainY !== null;

  const placed: AxisPlaced[] = [];
  const pile: AxisItem[] = [];

  for (const it of items) {
    const hasX = domainX !== null && isFiniteNum(it.valueX);
    const hasY = !twoD || isFiniteNum(it.valueY);
    if (!hasX || !hasY) {
      pile.push(it);
      continue;
    }
    const cx = linScale(it.valueX as number, domainX as AxisExtent, originX, spanX);
    let cy: number;
    if (twoD) {
      const raw = linScale(it.valueY as number, domainY as AxisExtent, originY, spanY);
      // Flip within [originY, originY+spanY] so a larger value sits higher (smaller screen y).
      cy = invertY ? originY + spanY - (raw - originY) : raw;
    } else {
      cy = laneY;
    }
    placed.push({ memberId: it.memberId, x: cx - dim(it.w) / 2, y: cy - dim(it.h) / 2, onAxis: true });
  }

  // No-value pile: a visible row below the plot (or below the lane in 1-D), left→right, so items
  // without the chosen field are still on the board and obviously "unplaced", never lost.
  const pileTop = (twoD ? originY + spanY : laneY) + noValueGap;
  let pileX = originX;
  for (const it of pile) {
    placed.push({ memberId: it.memberId, x: pileX, y: pileTop, onAxis: false });
    pileX += dim(it.w) + pileGap; // sanitize before the pile accumulates (MAX_VALUE would overflow to Infinity)
  }

  return { placed, domainX, domainY, twoD, originX, originY, spanX, spanY, laneY, invertY };
}

/**
 * Place `items` at continuous pixel positions by their numeric axis value(s) — the thin projection
 * of {@link axisPlot}'s `.placed` (SSOT — one geometry pass, so placements and the labelled axis can
 * never disagree). Returns exactly one {@link AxisPlaced} per input item; empty input → [].
 */
export function arrangeByAxis(items: readonly AxisItem[], opts?: ArrangeByAxisOptions): AxisPlaced[] {
  return axisPlot(items, opts).placed;
}

/** One labelled axis tick: the data `value` and its `pos` (pixel position along the axis, already
 *  inverted when `invert` is set). The caller formats `value` for its field (date, $, %). */
export interface AxisTick {
  readonly value: number;
  readonly pos: number;
}

/**
 * "Nice" axis ticks for a domain — the labelled-axis half of the primitive (the continuous analog
 * of `regionHeadingSpecs`, which labelled the discrete cluster regions). Produces evenly-spaced
 * ticks at human-friendly round values (a 1 / 2 / 5 x 10ⁿ step ladder) spanning the domain, each
 * with its pixel position, so a caller can draw gridlines + value labels for a timeline/scatter and
 * the arrangement reads as a real CHART, not just moved boxes. Pure, never throws, never NaN.
 * Degenerate domain (min >= max) → a single tick at the range start.
 */
export function axisTicks(
  domain: AxisExtent,
  span: number,
  origin: number,
  opts?: { count?: number; invert?: boolean },
): AxisTick[] {
  const s = isFiniteNum(span) && span > 0 ? span : 1;
  const o = isFiniteNum(origin) ? origin : 0;
  const target = Math.max(2, Math.min(20, Math.floor(isFiniteNum(opts?.count) ? (opts as { count: number }).count : 5)));
  const lo = Math.min(domain.min, domain.max);
  const hi = Math.max(domain.min, domain.max);
  const range = hi - lo;
  // Degenerate (min >= max) OR a NON-FINITE domain → a single tick at the range start. A non-finite
  // extent (min/max = ±Infinity or NaN) must never reach the loop below: `range` would be Infinity or
  // NaN, so `v <= hi` never becomes false and the tick loop HANGS (an infinite loop, worse than a NaN
  // tick). The `!(range > 0)` test alone catches NaN and <= 0 but NOT Infinity, so guard finiteness
  // explicitly. Same fail-closed rule as linScale's `!(d > 0)` — a pure leaf never hangs or emits a
  // non-finite value on a representable input.
  if (!(range > 0) || !Number.isFinite(range)) {
    return [{ value: Number.isFinite(lo) ? lo : 0, pos: o }];
  }

  const step = niceStep(range / target);
  const first = Math.ceil(lo / step) * step;
  const ticks: AxisTick[] = [];
  for (let v = first; v <= hi + step * 1e-9; v += step) {
    const t = (v - lo) / range;
    const along = opts?.invert ? o + s - t * s : o + t * s;
    ticks.push({ value: roundTick(v, step), pos: along });
  }
  return ticks;
}

/** One placeable axis-tick LABEL — the value, its formatted text, and the top-left of its label box
 *  positioned along one axis edge. The continuous analog of `RegionHeadingSpec` (which labelled the
 *  discrete cluster regions): this labels the continuous axis so a scatter/timeline reads as a real
 *  CHART. Pure DATA — no ids; the caller mints ids and materialises these as notes / an overlay. */
export interface AxisTickLabel {
  readonly value: number;
  readonly text: string; // the formatted label (date / $ / %), via the caller's `format`
  readonly x: number; // top-left of the label box
  readonly y: number;
}

/**
 * Project {@link axisTicks} into placeable {@link AxisTickLabel}s along ONE axis edge — the labelled
 * half of the continuous primitive (the continuous analog of `regionHeadingSpecs`). For the X axis,
 * labels sit in a row centred under each tick at the `edge` (y); for the Y axis, in a column at the
 * `edge` (x). Each value is formatted via the caller's `format` (raw number → human string — date,
 * price, percent); the leaf never assumes the field's meaning (L090). Pure, never throws.
 */
export function axisTickLabels(
  ticks: readonly AxisTick[],
  opts: { orientation: 'x' | 'y'; edge: number; labelW?: number; labelH?: number; format?: (v: number) => string },
): AxisTickLabel[] {
  const w = isFiniteNum(opts.labelW) && (opts.labelW as number) > 0 ? (opts.labelW as number) : 48;
  const h = isFiniteNum(opts.labelH) && (opts.labelH as number) > 0 ? (opts.labelH as number) : 20;
  const edge = isFiniteNum(opts.edge) ? opts.edge : 0;
  const fmt = typeof opts.format === 'function' ? opts.format : (v: number) => String(v);
  const horizontal = opts.orientation === 'x';
  return ticks.map((t) => ({
    value: t.value,
    text: fmt(t.value),
    x: horizontal ? t.pos - w / 2 : edge,
    y: horizontal ? edge : t.pos - h / 2,
  }));
}

/** Round a raw step UP to the nearest 1 / 2 / 5 x 10ⁿ — the classic "nice number" ladder that keeps
 *  tick labels human (…, 0.5, 1, 2, 5, 10, 20, 50, …). Bad input → 1. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag; // 1..10
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

/** Clean a tick value's floating-point noise to the step's decimal precision (0.30000000004 → 0.3). */
function roundTick(v: number, step: number): number {
  const decimals = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  const f = Math.pow(10, Math.min(12, Math.max(0, decimals)));
  return Math.round(v * f) / f;
}

// ─── TIMELINE-WITH-LANES (Gantt / roadmap) ──────────────────────────────────────────────────────
// The genuine COMPOSITION of the two arrange families: a CONTINUOUS X axis (linScale — plot each
// card by a number: date, order, sprint) crossed with DISCRETE Y LANES (orderedClusterKeys — one
// swimlane per key: owner, status, workstream). Neither family produces this alone: arrange-by-axis
// is continuous×continuous, arrange-by-field is discrete×discrete. This is continuous×discrete — a
// roadmap. Reuses `linScale`/`deriveExtent` (this file) + `orderedClusterKeys` (arrange-by-field) so
// it adds a placement, not a new engine (L069/L100). Blind to both fields (L090).

/** One card on the timeline: its continuous X value (date/order — null parks at the lane start) and
 *  its discrete lane key (the caller precomputes both; the leaf names neither field). */
export interface TimelineLaneItem {
  readonly memberId: string;
  readonly w: number;
  readonly h: number;
  readonly valueX: number | null;
  readonly laneKey: string;
}

/** One swimlane band — its raw `key`, band top `y` + height `h`, and item `count`. The "other half"
 *  of the timeline: a caller draws a lane header / background per band via {@link regionLabelFor}. */
export interface TimelineLane {
  readonly key: string;
  readonly y: number;
  readonly h: number;
  readonly count: number;
}

export interface TimelineLayout {
  readonly positions: ArrangedPosition[];
  readonly lanes: TimelineLane[];
  readonly domainX: AxisExtent | null; // the resolved X domain (for a matching axisTicks pass)
  readonly originX: number;
  readonly spanX: number;
}

export interface ArrangeTimelineOptions {
  readonly originX?: number; // pixel left of the plot (default 0)
  readonly originY?: number; // pixel top of the first lane band (default 0)
  readonly spanX?: number; // pixel WIDTH of the time axis (default 800)
  readonly laneHeight?: number; // band height per lane (default 100)
  readonly laneGap?: number; // gap between lane bands (default 16)
  readonly domainX?: AxisExtent; // X domain; omit → derived from the items' finite valueX
  readonly laneKeys?: readonly string[]; // explicit ORDERED lanes — kept even when empty (a visible lane)
}

/**
 * Lay `items` onto a timeline: X = the card's continuous value scaled across the axis, Y = the
 * centre of its discrete lane's band. Lanes are ordered by {@link orderedClusterKeys} (sorted, or
 * the given `laneKeys` first incl. empty lanes). Returns one {@link ArrangedPosition} per item (same
 * memberId set) plus one {@link TimelineLane} per lane. Empty input (no lane keys) → empty layout.
 *
 * Fail-closed: a card with a null/NaN `valueX` pins to the lane START (originX) rather than getting
 * a NaN coordinate; a degenerate X domain (all equal) pins every card to originX. Deterministic:
 * within a lane, input order is preserved (the caller/​bridge de-overlaps cards that share an X).
 */
export function arrangeTimelineLanes(items: readonly TimelineLaneItem[], opts?: ArrangeTimelineOptions): TimelineLayout {
  const originX = isFiniteNum(opts?.originX) ? (opts as ArrangeTimelineOptions).originX! : 0;
  const originY = isFiniteNum(opts?.originY) ? (opts as ArrangeTimelineOptions).originY! : 0;
  const spanX = isFiniteNum(opts?.spanX) && (opts as ArrangeTimelineOptions).spanX! > 0 ? (opts as ArrangeTimelineOptions).spanX! : 800;
  const laneHeight = isFiniteNum(opts?.laneHeight) && (opts as ArrangeTimelineOptions).laneHeight! > 0 ? (opts as ArrangeTimelineOptions).laneHeight! : 100;
  const laneGap = isFiniteNum(opts?.laneGap) && (opts as ArrangeTimelineOptions).laneGap! >= 0 ? (opts as ArrangeTimelineOptions).laneGap! : 16;

  const laneMode = Array.isArray(opts?.laneKeys);
  if (items.length === 0 && !laneMode) return { positions: [], lanes: [], domainX: null, originX, spanX };

  const domainX = opts?.domainX ?? deriveExtent(items.map((i) => i.valueX));

  // Bucket by lane, preserving input order within each lane.
  const buckets = new Map<string, TimelineLaneItem[]>();
  for (const it of items) {
    const b = buckets.get(it.laneKey);
    if (b) b.push(it);
    else buckets.set(it.laneKey, [it]);
  }
  const laneKeys = orderedClusterKeys([...buckets.keys()], opts?.laneKeys);

  const positions: ArrangedPosition[] = [];
  const lanes: TimelineLane[] = [];
  laneKeys.forEach((key, laneIndex) => {
    const bandTop = originY + laneIndex * (laneHeight + laneGap);
    const bandCenterY = bandTop + laneHeight / 2;
    const laneItems = buckets.get(key) ?? [];
    for (const it of laneItems) {
      const cx = domainX !== null && isFiniteNum(it.valueX) ? linScale(it.valueX as number, domainX, originX, spanX) : originX;
      positions.push({ memberId: it.memberId, x: cx - dim(it.w) / 2, y: bandCenterY - dim(it.h) / 2 });
    }
    lanes.push({ key, y: bandTop, h: laneHeight, count: laneItems.length });
  });

  return { positions, lanes, domainX, originX, spanX };
}
