// parts/ui/show/chart/chart-marks.tsx
//
// PURPOSE
//   The marks a chart draws its numbers with, as one open map: line, area, bar, stacked-bar, sparkline, step-line,
//   step-area, composed (bars, areas and lines together), histogram and candlestick on an x/y plot; donut, pie, radial,
//   radar, treemap and ranked-bar in a box; heatmap on a grid of cells. Chart.tsx chooses the mark by the id its data names
//   (chart placement `mark`), lays out the frame the mark asks for, and hands it everything already measured.
//   Registering another mark (registerChartMark) adds it to every chart, list view and placed chart at once.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A mark only draws: scales, hover, tooltips and states belong to Chart.tsx, so every mark scrubs, reads aloud and
//      shows its empty and loading states the same way.
//   2. Colour is a role, never a hex: series take `--chart-series-<n>` in the fixed categorical order (screen-look chart.css),
//      a tone takes `--chart-tone-<tone>`. Text never wears a series colour.
//   3. Craft numbers come from the inspiration brief: 2px
//      lines on a monotone curve, bars 62% of their slot up to 32px with a 4px rounded data end and square baseline, a
//      1px surface gap between stacked segments, hatched "so far" bars, ring thickness 30% of its radius with 2px gaps.
//      Geometry numbers follow shadcn/ui charts (MIT); the anatomy (inline-labelled dashed budget line, hatched partial
//      period, hover column band) follows saved dashboard references; no code is copied from any of them.
//   4. A mark says what it needs (`needs`: named roles, bins, categories) so the picker offers the matching choices; a
//      series without a role is read by position, so every mark draws something sensible from plain data.
//
// Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui, Apache-2.0, commit acdc998c): registry/charts/candlestick-chart.tsx, histogram-chart.tsx, radar-chart.tsx, radial-chart.tsx, pie-chart.tsx, depth-chart.tsx, chart-kit.tsx (fills); changes: SVG only, no recharts or framer-motion; roles and colours come from the look, every mark is a registered entry over ChartData.

import React from 'react';
import { arcAngles, arcPath, barPath, heatStep, heatThresholds, linePaths, polar, polygonPath, squarify, stack } from './chart-geometry';
import type { ChartData, ChartSeries } from './chart-types';

/** Everything an x/y mark draws from, already measured. */
export type CartesianContext = {
  data: ChartData;
  /** The x centre of each slot, and one slot's width. */
  xs: number[];
  slot: number;
  /** Value to y pixel. */
  y: (value: number) => number;
  /** The y of zero (or the bottom of the plot when zero is out of range). */
  baseY: number;
  plot: { left: number; right: number; top: number; bottom: number };
  hover: number | null;
  /** A per-chart id prefix for patterns and gradients. */
  uid: string;
  /** The y of the lowest reference line (a budget), when there is one: what lies above it reads as over. */
  limitY: number | null;
  /** The y of the placement's baseline, when the mark measures against one (a portfolio against its start); null otherwise. */
  baselineY: number | null;
};

/** Everything a ring or grid mark draws from. */
export type BoxContext = {
  data: ChartData;
  width: number;
  height: number;
  narrow: boolean;
  uid: string;
  hover: { series: number; slot: number } | null;
  setHover: (at: { series: number; slot: number } | null) => void;
  read: (value: number) => string;
  readShort: (value: number) => string;
};

/** What a mark is called and drawn as wherever a person picks one. */
type Named = { label: string; icon: string };
/** What a mark reads beyond one number per slot: named numbers (open, high, low, close), a number cut into ranges, or categories. */
export type ChartNeeds = { roles?: { id: string; label: string; formula?: string }[]; bins?: boolean; categories?: boolean };
export type ChartMark = Named & { needs?: ChartNeeds } & (
  | { frame: 'cartesian'; edge: 'band' | 'point'; stacked: boolean; bare?: boolean; /** The y axis starts at zero (default); false lets prices fill the plot; a function decides from the numbers drawn (a composed chart with candles is prices). */ zero?: boolean | ((data: ChartData) => boolean); /** The role whose reading is the slot's headline in place of the total of every series (close, for candles drawn inside a composed chart). */ headline?: string; /** The line bends however the person picks (default); false when the mark has its own curve. */ bends?: boolean; /** It measures against the placement's baseline: the scale reaches it, and the mark draws the dashed line and the tint under it (a portfolio against its start). */ baseline?: boolean; /** Roles it lays in a pane of the same name (a low strip under the plot, on a scale of its own) when the series names none (volume under a price). */ pane?: string[]; /** Whether a strip bar reads as a rise or a fall at a slot (the candle's direction); left out, the first series against the slot before. */ paneTone?: (data: ChartData, index: number) => 'rise' | 'fall'; /** The named numbers whose readings make the one quiet line over the plot (O 182.1  H 184.0 ...) at the pointed slot, the latest when nothing is pointed at; left out, the roles it `needs`. A series that names one of these roles is read; the roles it lays in a pane are left out. */ legend?: { id: string; label: string }[]; draw: (ctx: CartesianContext) => React.ReactNode }
  | { frame: 'box'; draw: (ctx: BoxContext) => React.ReactNode; /** It shows the hovered reading itself (a ring's centre). */ ownReadout?: boolean });

/** The series that play each named role: the one that says so, else the one at that position that names none. A role nobody plays is undefined. */
export function roleSeries(data: ChartData, roles: readonly { id: string }[]): (ChartSeries | undefined)[] {
  const claimed = new Set<number>();
  const explicit = roles.map(role => { const at = data.series.findIndex(series => series.role === role.id); if (at >= 0) claimed.add(at); return at; });
  return roles.map((_, index) => {
    if (explicit[index] >= 0) return data.series[explicit[index]];
    const byPosition = data.series[index];
    return byPosition && !byPosition.role && !claimed.has(index) ? byPosition : undefined;
  });
}
const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** Tones that are names for another tone until a look sets them itself (rise reads as good, fall as critical): data, so a new alias is a row here. */
const TONE_STANDS_IN: Readonly<Record<string, string>> = { rise: 'good', fall: 'critical' };
/** A tone's colour role: the look's own `--chart-tone-<tone>`, else the tone it stands in for, else `last`. */
export const toneColor = (tone: string, last?: string) => {
  const stands = TONE_STANDS_IN[tone];
  const rest = stands ? `var(--chart-tone-${stands}${last ? `, ${last}` : ''})` : last;
  return `var(--chart-tone-${tone}${rest ? `, ${rest}` : ''})`;
};
export const seriesColor = (series: ChartSeries, index: number) =>
  series.tone ? toneColor(series.tone, `var(--chart-series-${(index % 8) + 1})`) : `var(--chart-series-${((series.slot ?? index) % 8) + 1})`;
const seriesStyle = (color: string) => ({ '--series': color } as React.CSSProperties);

const clipAbove = (ctx: CartesianContext) => `${ctx.uid}-over`;

const baseLine = (ctx: CartesianContext) => `${ctx.uid}-base-line`;
const baseFill = (ctx: CartesianContext) => `${ctx.uid}-base-fill`;
const riseRole = 'var(--chart-tone-rise, var(--chart-tone-good))';
const fallRole = 'var(--chart-tone-fall, var(--chart-tone-critical))';

/**
 * The stroke and the fill of a chart measured against a baseline: two gradients across the plot, split at the baseline's y.
 * Over it they wear the rise role, under it the fall role (roles only, never a colour); the fill fades toward the baseline.
 */
function BaselineGradients({ ctx }: { ctx: CartesianContext }) {
  if (ctx.baselineY === null) return null;
  const { top, bottom } = ctx.plot;
  const split = Math.min(1, Math.max(0, (ctx.baselineY - top) / Math.max(1, bottom - top)));
  const at = `${(split * 100).toFixed(3)}%`;
  const stop = (offset: string, role: string, opacity?: number) => <stop offset={offset} style={{ stopColor: role }} stopOpacity={opacity} />;
  return (
    <>
      <linearGradient id={baseLine(ctx)} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={top} y2={bottom} data-split={at}>
        {stop('0%', riseRole)}{stop(at, riseRole)}{stop(at, fallRole)}{stop('100%', fallRole)}
      </linearGradient>
      <linearGradient id={baseFill(ctx)} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={top} y2={bottom} data-split={at}>
        {stop('0%', riseRole, 0.3)}{stop(at, riseRole, 0.02)}{stop(at, fallRole, 0.02)}{stop('100%', fallRole, 0.3)}
      </linearGradient>
    </>
  );
}

/** The over-the-limit copy of a line or area: the same path, clipped to above the reference line, in the alert tone. */
function OverLimit({ ctx, d, area }: { ctx: CartesianContext; d: string; area?: boolean }) {
  if (ctx.limitY === null || !d) return null;
  return <path className={area ? 'chart-area chart-over' : 'chart-line chart-over'} d={d} clipPath={`url(#${clipAbove(ctx)})`} />;
}

function LimitClip({ ctx }: { ctx: CartesianContext }) {
  if (ctx.limitY === null) return null;
  return (
    <clipPath id={clipAbove(ctx)}>
      <rect x={ctx.plot.left - 4} y={ctx.plot.top - 8} width={ctx.plot.right - ctx.plot.left + 8} height={Math.max(0, ctx.limitY - ctx.plot.top + 8)} />
    </clipPath>
  );
}

type LineLook = {
  /** Which series wear an area under their line. */
  fill: (series: ChartSeries, index: number) => boolean;
  /** Areas stack (a total split into parts) rather than overlap. */
  stacked: boolean;
  /** A curve this mark always draws with; otherwise the placement's, else monotone. */
  curve?: string;
  /** Define the over-the-limit clip (once per chart). */
  clip?: boolean;
};

function drawLines(ctx: CartesianContext, { fill, stacked, curve, clip = true }: LineLook) {
  const { data, xs, y, uid } = ctx;
  // Measured against a baseline, an area closes on it (not on zero), and a single series wears the rise tone over it and the fall tone under it.
  const baseY = ctx.baselineY ?? ctx.baseY;
  const split = ctx.baselineY !== null && !(stacked && data.series.length > 1);
  const shape = curve ?? data.curve ?? true;
  const layers = stacked && data.series.length > 1 ? stack(data.series.map(series => series.values)) : null;
  return (
    <>
      <defs>
        {clip ? <LimitClip ctx={ctx} /> : null}
        <BaselineGradients ctx={ctx} />
        {data.series.map((series, index) => (fill(series, index) ? (
          <React.Fragment key={series.id}>
            <linearGradient id={`${uid}-fill-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesColor(series, index)} stopOpacity={layers ? 0.42 : 0.28} />
              <stop offset="100%" stopColor={seriesColor(series, index)} stopOpacity={layers ? 0.16 : 0.02} />
            </linearGradient>
            <Hatch uid={uid} index={index} color={seriesColor(series, index)} prefix="a" />
          </React.Fragment>
        ) : null))}
      </defs>
      {ctx.baselineY !== null ? <line className="chart-baseline" x1={ctx.plot.left} x2={ctx.plot.right} y1={ctx.baselineY} y2={ctx.baselineY} /> : null}
      {data.series.map((series, index) => {
        const filled = fill(series, index);
        const tops = (layers ? layers[index].upper : series.values).map(value => (value === null ? null : y(value)));
        const lower = layers ? layers[index].lower.map(value => (value === null ? null : y(value))) : undefined;
        const { line, area } = linePaths(xs, tops, baseY, series.curve ?? shape, lower);
        const single = tops.filter(value => value !== null).length === 1;
        const hovered = ctx.hover !== null ? tops[ctx.hover] : null;
        return (
          <g key={series.id} className="chart-series" style={looksStyle(seriesColor(series, index), uid, index, 'a')} data-baselined={split ? 'true' : undefined} data-dashed={series.dashed ? 'true' : undefined}>
            {filled ? <path className="chart-area" d={area} fill={`url(#${split ? baseFill(ctx) : `${uid}-fill-${index}`})`} /> : null}
            {filled && !layers ? <OverLimit ctx={ctx} d={area} area /> : null}
            <path className="chart-line" d={line} pathLength={1} style={split ? ({ '--base-stroke': `url(#${baseLine(ctx)})` } as React.CSSProperties) : undefined} />
            {!layers ? <OverLimit ctx={ctx} d={line} /> : null}
            {/* A lone reading has no line to draw: its point is shown instead of nothing. */}
            {single ? tops.map((top, at) => (top === null ? null : <circle key={at} className="chart-dot" cx={xs[at]} cy={top} r={4} />)) : null}
            {hovered !== null && hovered !== undefined && ctx.hover !== null ? <circle className="chart-hover-dot" cx={xs[ctx.hover]} cy={hovered} r={4} /> : null}
          </g>
        );
      })}
    </>
  );
}

/** A chart measured against a baseline reads as change from it, so its scale fits the numbers instead of starting at zero. */
const unlessBaselined = (data: ChartData) => typeof data.baseline !== 'number';

function lineOrArea(fill: boolean, curve?: string) {
  return function LineOrArea(ctx: CartesianContext) {
    return drawLines(ctx, { fill: () => fill, stacked: fill, curve });
  };
}

/** The same context holding only some of its series, each keeping the colour slot it had among all of them. */
const only = (ctx: CartesianContext, picked: number[]): CartesianContext => ({
  ...ctx, data: { ...ctx.data, series: picked.map(at => ({ ...ctx.data.series[at], slot: ctx.data.series[at].slot ?? at })) },
});

/** The roles that make a series part of a candle (the price roles; volume is drawn in its own pane). */
const CANDLE_PRICE = ['open', 'high', 'low', 'close'];
const isCandle = (series: ChartSeries) => Boolean(series.role && CANDLE_PRICE.includes(series.role));

/**
 * Bars, then areas, then lines, each series as its own `draw` says (the first defaults to bars, the rest to lines). Series
 * that play the price roles (open, high, low, close) are drawn together as candles in this same plot, under the lines.
 */
function Composed(ctx: CartesianContext) {
  const candles = ctx.data.series.flatMap((series, index) => (isCandle(series) ? [index] : []));
  const first = ctx.data.series.findIndex(series => !isCandle(series));
  const kinds = ctx.data.series.map((series, index) => (isCandle(series) ? 'candle' : series.draw === 'bar' || series.draw === 'area' || series.draw === 'line' ? series.draw : index === first && !candles.length ? 'bar' : 'line'));
  const at = (kind: string) => kinds.flatMap((one, index) => (one === kind ? [index] : []));
  const bar = at('bar'), area = at('area'), line = at('line');
  return (
    <>
      <defs><LimitClip ctx={ctx} /></defs>
      {bar.length ? bars(false)(only(ctx, bar)) : null}
      {area.length ? drawLines(only(ctx, area), { fill: () => true, stacked: false, clip: false }) : null}
      {candles.length ? Candlestick(only(ctx, candles)) : null}
      {line.length ? drawLines(only(ctx, line), { fill: () => false, stacked: false, clip: false }) : null}
    </>
  );
}

const CANDLE_ROLES = [{ id: 'open', label: 'Open', formula: 'first' }, { id: 'high', label: 'High', formula: 'most' }, { id: 'low', label: 'Low', formula: 'least' }, { id: 'close', label: 'Close', formula: 'latest' }, { id: 'volume', label: 'Volume', formula: 'sum' }];
const PANE_ROLES = ['volume'];

/** A slot's candle rose when it closed at or above its open. */
function candleTone(data: ChartData, index: number): 'rise' | 'fall' {
  const [open, , , close] = roleSeries(data, CANDLE_ROLES);
  const c = close?.values[index], o = open?.values[index] ?? c;
  return finite(c) && finite(o) && c < o ? 'fall' : 'rise';
}

/** The slot's reading against the slot before it, for a strip with no candle to borrow a direction from. */
function changeTone(data: ChartData, index: number): 'rise' | 'fall' {
  const values = data.series[0]?.values ?? [];
  const now = values[index], before = values[index - 1];
  return finite(now) && finite(before) && now < before ? 'fall' : 'rise';
}

/** A pane bar's direction in a composed chart: from its candle when candles are drawn, else against the slot before. */
function composedTone(data: ChartData, index: number): 'rise' | 'fall' {
  return data.series.some(isCandle) ? candleTone(data, index) : changeTone(data, index);
}

/**
 * One pane's low strip under the plot: its series as short bars on a scale of their own (zero to the largest of them),
 * toned rise or fall by `tone` at that slot. Chart.tsx hands it the strip's top and bottom in pixels.
 */
export function PaneBars({ name, series, xs, slot, top, bottom, hover, tone }: {
  name?: string; series: ChartSeries[]; xs: number[]; slot: number; top: number; bottom: number; hover: number | null;
  tone: (index: number) => 'rise' | 'fall';
}) {
  const width = Math.max(2, Math.min(slot * 0.58, 28));
  // One scale for the whole strip: zero to the largest reading of any series in it.
  const most = Math.max(0, ...series.flatMap(one => one.values.filter(finite)));
  if (most <= 0) return null;
  return (
    <g className="chart-pane" data-pane={name}>
      {series.map(one => {
        return (
          <g key={one.id} className="chart-pane-series">
            {one.values.map((value, at) => (finite(value) && value > 0 ? (
              <rect
                key={at}
                className="chart-pane-bar"
                data-direction={tone(at)}
                data-hovered={hover === at ? 'true' : undefined}
                data-dimmed={hover !== null && hover !== at ? 'true' : undefined}
                x={xs[at] - width / 2}
                y={bottom - ((value / most) * (bottom - top))}
                width={width}
                height={Math.max(1, (value / most) * (bottom - top))}
                rx={1}
              />
            ) : null))}
          </g>
        );
      })}
    </g>
  );
}

/** A wick from the low to the high and a body from the open to the close: rising in the rise tone, falling in the fall tone. */
function Candlestick(ctx: CartesianContext) {
  const { data, xs, slot, y } = ctx;
  const [open, high, low, close] = roleSeries(data, CANDLE_ROLES);
  const bodyWidth = Math.max(3, Math.min(slot * 0.58, 28));
  return (
    <g className="chart-series chart-candles">
      {data.slots.map((_, at) => {
        const c = close?.values[at], o = open?.values[at] ?? c;
        if (!finite(c) || !finite(o)) return null;
        const top = Math.max(o, c, high?.values[at] ?? -Infinity), bottom = Math.min(o, c, low?.values[at] ?? Infinity);
        const yOpen = y(o), yClose = y(c);
        return (
          <g
            key={at}
            className="chart-candle"
            data-direction={c >= o ? 'rise' : 'fall'}
            data-hovered={ctx.hover === at ? 'true' : undefined}
            data-dimmed={ctx.hover !== null && ctx.hover !== at ? 'true' : undefined}
            style={{ animationDelay: `${Math.min(300, at * 18)}ms` }}
          >
            <line className="chart-wick" x1={xs[at]} x2={xs[at]} y1={y(top)} y2={y(bottom)} />
            <rect className="chart-candle-body" x={xs[at] - bodyWidth / 2} y={Math.min(yOpen, yClose)} width={bodyWidth} height={Math.max(1, Math.abs(yOpen - yClose))} rx={1.5} />
          </g>
        );
      })}
    </g>
  );
}

/** Bars that touch (a pixel between), one per range of a number: how many records fall in each. A second series lays over the first. */
function Histogram(ctx: CartesianContext) {
  const { data, xs, slot, y, baseY, uid } = ctx;
  const width = Math.max(1, slot - 1);
  return (
    <>
      <defs>{data.series.map((series, index) => <Hatch key={series.id} uid={uid} index={index} color={seriesColor(series, index)} />)}</defs>
      {data.series.map((series, index) => (
        <g key={series.id} className="chart-series chart-bins" data-layer={index} style={looksStyle(seriesColor(series, index), uid, index)}>
          {series.values.map((value, at) => (!finite(value) || value === 0 ? null : (
            <path
              key={at}
              className="chart-bar chart-bin"
              data-hovered={ctx.hover === at ? 'true' : undefined}
              data-dimmed={ctx.hover !== null && ctx.hover !== at ? 'true' : undefined}
              d={barPath(xs[at] - width / 2, baseY, width, y(value), 2)}
              style={{ animationDelay: `${Math.min(300, at * 12)}ms` }}
            />
          )))}
        </g>
      ))}
    </>
  );
}

function Hatch({ uid, index, color, prefix = '' }: { uid: string; index: number; color: string; prefix?: string }) {
  return (
    <>
      <pattern id={`${uid}-${prefix}hatch-${index}`} patternUnits="userSpaceOnUse" width={5} height={5} patternTransform="rotate(45)">
        <rect width={5} height={5} fill={color} opacity={0.18} />
        <line x1={0} y1={0} x2={0} y2={5} stroke={color} strokeWidth={2} opacity={0.75} />
      </pattern>
      <pattern id={`${uid}-${prefix}dots-${index}`} patternUnits="userSpaceOnUse" width={6} height={6}>
        <rect width={6} height={6} fill={color} opacity={0.1} />
        <circle cx={3} cy={3} r={1.2} fill={color} opacity={0.75} />
      </pattern>
    </>
  );
}
/** The series' own pattern fills, handed to chart.css as variables so a look can pick them. */
const looksStyle = (color: string, uid: string, index: number, prefix = '') => ({
  '--series': color, '--fill-hatched': `url(#${uid}-${prefix}hatch-${index})`, '--fill-dotted': `url(#${uid}-${prefix}dots-${index})`,
} as React.CSSProperties);

function bars(stacked: boolean) {
  return function Bars(ctx: CartesianContext) {
    const { data, xs, slot, y, baseY, uid } = ctx;
    const count = stacked ? 1 : Math.max(1, data.series.length);
    const groupWidth = Math.min(slot * 0.66, 72 * count);
    const gap = count > 1 ? 2 : 0;
    const width = Math.max(1, (groupWidth - gap * (count - 1)) / count);
    const layers = stacked ? stack(data.series.map(series => series.values)) : null;
    // The topmost filled layer of each slot: only its end is rounded.
    const topLayer = data.slots.map((_, at) => {
      if (!layers) return -1;
      for (let index = layers.length - 1; index >= 0; index -= 1) if (layers[index].upper[at] !== null && layers[index].upper[at] !== layers[index].lower[at]) return index;
      return -1;
    });
    return (
      <>
        <defs>{data.series.map((series, index) => <Hatch key={series.id} uid={uid} index={index} color={seriesColor(series, index)} />)}</defs>
        {data.series.map((series, index) => (
          <g key={series.id} className="chart-series" style={looksStyle(seriesColor(series, index), uid, index)}>
            {series.values.map((value, at) => {
              if (value === null || value === 0) return null;
              const x = stacked ? xs[at] - width / 2 : xs[at] - groupWidth / 2 + index * (width + gap);
              const y0 = layers ? y(layers[index].lower[at] ?? 0) : baseY;
              const y1 = layers ? y(layers[index].upper[at] ?? 0) : y(value);
              const top = !layers || topLayer[at] === index;
              // A segment under another keeps square ends and gives up a pixel to the surface between them.
              const inset = top ? 0 : y1 < y0 ? 1 : -1;
              const tone = series.tones?.[at];
              return (
                <path
                  key={at}
                  className="chart-bar"
                  data-hovered={ctx.hover === at ? 'true' : undefined}
                  data-dimmed={ctx.hover !== null && ctx.hover !== at ? 'true' : undefined}
                  d={barPath(x, y0, width, y1 + inset, top ? 4 : 0)}
                  data-tone={tone ?? undefined}
                  fill={data.slots[at]?.partial ? `url(#${uid}-hatch-${index})` : undefined}
                  style={{ animationDelay: `${Math.min(300, at * 18)}ms`, ...(tone ? { '--series': toneColor(tone) } : {}) } as React.CSSProperties}
                />
              );
            })}
          </g>
        ))}
      </>
    );
  };
}

/** The square a ring-shaped mark draws in: beside its legend on a wide chart, alone on a phone. */
const ringSize = ({ width, height, narrow }: Pick<BoxContext, 'width' | 'height' | 'narrow'>) =>
  Math.round(Math.max(112, Math.min(narrow ? Math.min(width - 8, 176) : Math.min(width * 0.44, height), 224)));

const slotColor = (at: number) => `var(--chart-series-${(at % 8) + 1})`;
const percent = (value: number, total: number) => (total > 0 ? `${Math.round((value / total) * 100)}%` : '');

/** One row per slot: its colour, name, reading and share of the whole; hovering a row highlights its mark. */
function SlotLegend({ ctx, values, className }: { ctx: BoxContext; values: number[]; className: string }) {
  const { data, hover, setHover, read } = ctx;
  const total = values.reduce((sum, value) => sum + value, 0);
  const active = hover?.slot ?? null;
  return (
    <ul className={`chart-legend ${className}`}>
      {data.slots.map((slot, at) => (
        <li key={slot.key} className="chart-legend-row" data-active={active === at ? 'true' : undefined} onPointerEnter={() => setHover({ series: 0, slot: at })} onPointerLeave={() => setHover(null)}>
          <span className="chart-swatch" style={seriesStyle(slotColor(at))} />
          <span className="chart-legend-label">{slot.label}</span>
          <span className="chart-legend-value">{read(values[at])}</span>
          <span className="chart-legend-share">{percent(values[at], total)}</span>
        </li>
      ))}
    </ul>
  );
}

const firstValues = (data: ChartData) => (data.series[0]?.values ?? []).map(value => (finite(value) ? value : 0));

/** A ring (or, solid, a whole pie) split by the first series; the centre of a ring reads the hovered slice or the total. */
function rings(solid: boolean) {
  return function Rings(ctx: BoxContext) {
    const { data, narrow, uid, hover, setHover, read } = ctx;
    const values = firstValues(data);
    const total = values.reduce((sum, value) => sum + value, 0);
    const size = ringSize(ctx);
    const outer = size / 2;
    const thickness = solid ? outer : Math.max(14, outer * 0.3);
    const angles = arcAngles(values, values.filter(value => value > 0).length > 1 ? 2 / outer : 0);
    const active = hover?.slot ?? null;
    const shown = active !== null ? values[active] : total;
    const caption = active !== null ? data.slots[active]?.label ?? '' : 'Total';
    return (
      <div className="chart-donut" data-shape={solid ? 'pie' : undefined} data-narrow={narrow ? 'true' : undefined}>
        <div className="chart-donut-figure" style={{ width: size, height: size }}>
          <svg className="chart-donut-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="presentation" onPointerLeave={() => setHover(null)}>
            {solid ? null : <path className="chart-donut-track" d={arcPath(outer, outer, outer - thickness, outer - 3, 0, Math.PI * 2)} />}
            {angles.map((angle, at) => (angle.a1 > angle.a0 ? (
              <path
                key={data.slots[at].key}
                id={`${uid}-slice-${at}`}
                className="chart-slice"
                data-dimmed={active !== null && active !== at ? 'true' : undefined}
                style={seriesStyle(slotColor(at))}
                d={arcPath(outer, outer, solid ? 0 : outer - thickness, active === at ? outer : outer - 3, angle.a0, angle.a1)}
                onPointerEnter={() => setHover({ series: 0, slot: at })}
              />
            ) : null))}
          </svg>
          {solid ? null : (
            <div className="chart-donut-centre" aria-hidden="true">
              <span className="chart-donut-caption">{caption}</span>
              <span className="chart-donut-value">{read(shown)}</span>
              {active !== null && total > 0 ? <span className="chart-donut-share">{Math.round((values[active] / total) * 100)}%</span> : null}
            </div>
          )}
        </div>
        <SlotLegend ctx={ctx} values={values} className="chart-donut-legend" />
      </div>
    );
  };
}

/** Concentric bars: one ring per slot, its sweep (up to three quarters of a turn) the share of the largest reading. */
function Radial(ctx: BoxContext) {
  const { data, narrow, uid, hover, setHover } = ctx;
  const values = firstValues(data);
  const largest = Math.max(0, ...values);
  const size = ringSize(ctx);
  const outer = size / 2;
  const count = Math.max(1, values.length);
  const step = (outer * 0.78) / count;
  const thickness = Math.max(2, Math.min(16, step * 0.72));
  const sweep = Math.PI * 1.5;
  const active = hover?.slot ?? null;
  return (
    <div className="chart-donut chart-radial" data-narrow={narrow ? 'true' : undefined}>
      <div className="chart-donut-figure" style={{ width: size, height: size }}>
        <svg className="chart-donut-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="presentation" onPointerLeave={() => setHover(null)}>
          {values.map((value, at) => {
            const radius = outer - 3 - at * step;
            const inner = Math.max(1, radius - thickness);
            return (
              <g key={data.slots[at].key} onPointerEnter={() => setHover({ series: 0, slot: at })}>
                <path className="chart-donut-track" d={arcPath(outer, outer, inner, radius, 0, sweep)} />
                {value > 0 && largest > 0 ? (
                  <path
                    id={`${uid}-slice-${at}`}
                    className="chart-slice"
                    data-dimmed={active !== null && active !== at ? 'true' : undefined}
                    style={seriesStyle(slotColor(at))}
                    d={arcPath(outer, outer, inner, radius, 0, Math.max(0.02, (value / largest) * sweep))}
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <SlotLegend ctx={ctx} values={values} className="chart-donut-legend" />
    </div>
  );
}

/** A web: each slot is a spoke, each series a shape across them, so profiles compare at a glance. */
function Radar(ctx: BoxContext) {
  const { data, width, narrow, uid, hover, setHover, readShort } = ctx;
  const spokes = data.slots.length;
  const pad = narrow ? 34 : 54;
  const span = Math.max(112, Math.min(narrow ? width - 2 * pad : 280, 280));
  const box = span + pad * 2;
  const centre = box / 2, radius = span / 2;
  const top = Math.max(0, ...data.series.flatMap(series => series.values.map(value => (finite(value) ? value : 0))));
  const angleOf = (at: number) => (spokes ? (at / spokes) * Math.PI * 2 : 0);
  const pointAt = (at: number, value: number) => polar(centre, centre, top > 0 ? (value / top) * radius : 0, angleOf(at));
  const label = (text: string) => (text.length > (narrow ? 8 : 14) ? `${text.slice(0, narrow ? 7 : 13)}\u2026` : text);
  const active = hover?.slot ?? null;
  return (
    <div className="chart-radar" data-narrow={narrow ? 'true' : undefined}>
      <svg className="chart-radar-web" width={box} height={box} viewBox={`0 0 ${box} ${box}`} role="presentation" onPointerLeave={() => setHover(null)}>
        <defs>{data.series.map((series, index) => <Hatch key={series.id} uid={uid} index={index} color={seriesColor(series, index)} />)}</defs>
        {[0.25, 0.5, 0.75, 1].map(level => (
          <path key={level} className="chart-radar-ring" d={polygonPath(data.slots.map((_, at) => polar(centre, centre, radius * level, angleOf(at))))} />
        ))}
        {data.slots.map((slot, at) => {
          const end = polar(centre, centre, radius, angleOf(at));
          const name = polar(centre, centre, radius + 10, angleOf(at));
          return (
            <g key={slot.key} data-active={active === at ? 'true' : undefined} onPointerEnter={() => setHover({ series: 0, slot: at })}>
              <line className="chart-radar-spoke" x1={centre} y1={centre} x2={end.x} y2={end.y} />
              <text className="chart-tick chart-radar-label" x={name.x} y={name.y + 4} textAnchor={Math.abs(name.x - centre) < 4 ? 'middle' : name.x > centre ? 'start' : 'end'}>{label(slot.label)}</text>
            </g>
          );
        })}
        {top > 0 ? data.series.map((series, index) => {
          const points = series.values.map((value, at) => pointAt(at, finite(value) ? value : 0));
          return (
            <g key={series.id} className="chart-series chart-radar-shape" style={looksStyle(seriesColor(series, index), uid, index)} data-dashed={series.dashed ? 'true' : undefined}>
              <path className="chart-radar-area" d={polygonPath(points)} />
              {points.map((point, at) => (
                <circle
                  key={at}
                  className="chart-dot chart-radar-point"
                  data-active={hover?.series === index && active === at ? 'true' : undefined}
                  cx={point.x}
                  cy={point.y}
                  r={hover?.series === index && active === at ? 5 : 3}
                  onPointerEnter={() => setHover({ series: index, slot: at })}
                >
                  <title>{`${series.label}, ${data.slots[at]?.label}: ${readShort(series.values[at] ?? 0)}`}</title>
                </circle>
              ))}
            </g>
          );
        }) : null}
      </svg>
      {data.series.length > 1 ? (
        <ul className="chart-legend chart-radar-legend">
          {data.series.map((series, index) => (
            <li key={series.id} className="chart-legend-row" data-dashed={series.dashed ? 'true' : undefined}>
              <span className="chart-swatch" style={seriesStyle(seriesColor(series, index))} />
              <span className="chart-legend-label">{series.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Tiles whose areas are the readings of the first series; a tile wears its tone, else the next colour in order. */
function Treemap(ctx: BoxContext) {
  const { data, width, height, narrow, hover, setHover, readShort } = ctx;
  const values = firstValues(data);
  const w = Math.max(120, width - 2);
  const h = Math.max(150, Math.min(height, narrow ? 260 : 340));
  const tiles = squarify(values, w, h);
  const total = values.reduce((sum, value) => sum + value, 0);
  const tones = data.series[0]?.tones;
  const active = hover?.slot ?? null;
  return (
    <div className="chart-treemap" data-narrow={narrow ? 'true' : undefined}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="presentation" onPointerLeave={() => setHover(null)}>
        {tiles.map(tile => {
          const tone = tones?.[tile.index];
          const words = data.slots[tile.index]?.label ?? '';
          const room = Math.floor((tile.w - 12) / 6.5);
          // Name on the first line, the number and share on a second line below it; a tile too small for a whole second line
          // keeps only its name, and a tile too small for the name wears no words (the tooltip still names it).
          const short = readShort(values[tile.index]);
          const reading = `${short} ${percent(values[tile.index], total)}`.trim().length <= room ? `${short} ${percent(values[tile.index], total)}`.trim() : short;
          return (
            <g
              key={data.slots[tile.index].key}
              className="chart-tile"
              data-dimmed={active !== null && active !== tile.index ? 'true' : undefined}
              data-hovered={active === tile.index ? 'true' : undefined}
              data-tone={tone ?? undefined}
              style={seriesStyle(tone ? toneColor(tone) : slotColor(tile.index))}
              onPointerEnter={() => setHover({ series: 0, slot: tile.index })}
            >
              <rect className="chart-tile-fill" x={tile.x} y={tile.y} width={tile.w} height={tile.h} rx={4} />
              {room >= 4 && tile.h >= 30 ? (
                <>
                  <text className="chart-tile-label" x={tile.x + 8} y={tile.y + 18}>{words.length > room ? `${words.slice(0, Math.max(1, room - 1))}\u2026` : words}</text>
                  {tile.h >= 50 && reading.length <= room ? <text className="chart-tile-value" x={tile.x + 8} y={tile.y + 37}>{reading}</text> : null}
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Horizontal bars from the biggest down. Two series draw as a diverging pair: the first to the left of the name, the second to
 * the right. A series that names a `bar` (the id or role of another series, usually a running total) takes its bar length from
 * that one and the named series is not drawn as a column of its own; when any series does, the bar sits behind its row, right
 * aligned and toned by the series that owns the row (an order book: asks fall, bids rise, the length the depth so far).
 * Slots that carry a position (`at`) keep their order; the rest are ranked by the first series.
 */
function RankedBar(ctx: BoxContext) {
  const { data, hover, setHover, read } = ctx;
  const lengthOf = (series: ChartSeries) => (series.bar ? data.series.find(one => one !== series && (one.id === series.bar || one.role === series.bar)) : undefined);
  const sources = new Set(data.series.map(lengthOf).filter(Boolean));
  const drawn = data.series.filter(series => !sources.has(series));
  const behind = drawn.some(series => lengthOf(series));
  const [first, second] = drawn;
  const placed = data.slots.length > 0 && data.slots.every(slot => typeof slot.at === 'number');
  const order = data.slots.map((_, at) => at);
  if (!placed) order.sort((a, b) => (first?.values[b] ?? -Infinity) - (first?.values[a] ?? -Infinity));
  const sized = (behind ? drawn : drawn.slice(0, 2)).flatMap(series => (lengthOf(series) ?? series).values);
  const largest = Math.max(0, ...sized.map(value => (finite(value) ? Math.abs(value) : 0)));
  const share = (value: number | null | undefined) => (finite(value) && largest > 0 ? `${Math.max(0.5, (Math.abs(value) / largest) * 100)}%` : '0%');
  return (
    <ol className="chart-ranked" data-pair={second && !behind ? 'true' : undefined} data-behind={behind ? 'true' : undefined} onPointerLeave={() => setHover(null)}>
      {order.map(at => {
        const owner = behind ? drawn.find(series => finite(series.values[at])) : undefined;
        const ownerAt = owner ? drawn.indexOf(owner) : 0;
        return (
          <li key={data.slots[at].key} className="chart-ranked-row" style={owner ? seriesStyle(seriesColor(owner, ownerAt)) : undefined} data-active={hover?.slot === at ? 'true' : undefined} data-dimmed={hover && hover.slot !== at ? 'true' : undefined} onPointerEnter={() => setHover({ series: Math.max(0, data.series.indexOf(owner ?? first)), slot: at })}>
            <span className="chart-ranked-label">{data.slots[at].label}</span>
            {behind ? (
              <>
                <span className="chart-ranked-track">
                  {owner ? <span className="chart-ranked-fill" data-side="behind" style={{ ...seriesStyle(seriesColor(owner, ownerAt)), width: share((lengthOf(owner) ?? owner).values[at]) }} /> : null}
                </span>
                <span className="chart-ranked-value">{owner ? read(owner.values[at] as number) : ''}</span>
                <span className="chart-ranked-value chart-ranked-total">{owner && lengthOf(owner) && finite(lengthOf(owner)!.values[at]) ? read(lengthOf(owner)!.values[at] as number) : ''}</span>
              </>
            ) : (
              <>
                <span className="chart-ranked-track">
                  {first ? <span className="chart-ranked-fill" data-side={second ? 'left' : undefined} style={{ ...seriesStyle(seriesColor(first, 0)), width: share(first.values[at]) }} /> : null}
                  {second ? <span className="chart-ranked-fill" data-side="right" style={{ ...seriesStyle(seriesColor(second, 1)), width: share(second.values[at]) }} /> : null}
                </span>
                <span className="chart-ranked-value">{finite(first?.values[at]) ? read(first!.values[at] as number) : ''}</span>
                {second ? <span className="chart-ranked-value">{finite(second.values[at]) ? read(second.values[at] as number) : ''}</span> : null}
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

type Cell = { x: number; y: number; w: number; h: number; value: number | null; series: number; slot: number };

function Heatmap(ctx: BoxContext) {
  const { data, width, hover, setHover, readShort } = ctx;
  const thresholds = heatThresholds(data.series.flatMap(series => series.values), 4);
  const calendar = data.series.length === 1 && data.bucket === 'day' && data.slots.every(slot => slot.t !== undefined);
  const cells: Cell[] = [];
  let svgWidth = width, svgHeight = 0, labelColumn = 0;
  let rowLabels: { y: number; label: string }[] = [];
  let colLabels: { x: number; label: string }[] = [];
  if (calendar) {
    // One column per week, Monday on top, so a year of days reads at a glance.
    // The cells grow to fill the card's width (never below 12px, never past 36px); a long span keeps 12px and scrolls.
    const gap = 3;
    labelColumn = 30;
    const firstDay = (new Date(data.slots[0].t!).getDay() + 6) % 7;
    const weeks = Math.max(1, Math.ceil((data.slots.length + firstDay) / 7));
    const size = Math.max(12, Math.min(36, Math.floor((width - labelColumn + gap) / weeks - gap)));
    data.slots.forEach((slot, at) => {
      const position = at + firstDay;
      const column = Math.floor(position / 7), row = position % 7;
      cells.push({ x: column * (size + gap), y: row * (size + gap), w: size, h: size, value: data.series[0].values[at], series: 0, slot: at });
      if (row === 0 || at === 0) {
        const day = new Date(slot.t!);
        if (day.getDate() <= 7 || at === 0) colLabels.push({ x: column * (size + gap), label: day.toLocaleDateString(undefined, { month: 'short' }) });
      }
    });
    rowLabels = [0, 2, 4].map(row => ({ y: row * (size + gap), label: new Date(2026, 0, 5 + row).toLocaleDateString(undefined, { weekday: 'short' }) }));
    svgWidth = Math.max(0, ...cells.map(cell => cell.x + cell.w));
    svgHeight = 7 * (size + gap) + 16;
  } else {
    labelColumn = Math.min(140, Math.max(48, ...data.series.map(series => series.label.length * 6.5))) + 8;
    const columns = Math.max(1, data.slots.length);
    const cellW = Math.max(14, (width - labelColumn) / columns - 4);
    const cellH = Math.min(36, Math.max(14, cellW));
    data.series.forEach((series, row) => {
      rowLabels.push({ y: row * (cellH + 4) + cellH / 2 - 6, label: series.label });
      series.values.forEach((value, at) => cells.push({ x: at * (cellW + 4), y: row * (cellH + 4), w: cellW, h: cellH, value, series: row, slot: at }));
    });
    const every = Math.max(1, Math.ceil(data.slots.length / 8));
    colLabels = data.slots.flatMap((slot, at) => (at % every === 0 ? [{ x: at * (cellW + 4), label: slot.label }] : []));
    svgWidth = columns * (cellW + 4);
    svgHeight = data.series.length * (cellH + 4) + 16;
  }
  return (
    <div className="chart-heat" data-calendar={calendar ? 'true' : undefined}>
      <div className="chart-heat-body">
        {rowLabels.length ? (
          <svg width={labelColumn} height={svgHeight} role="presentation">
            {rowLabels.map(row => <text key={`${row.label}:${row.y}`} className="chart-tick" x={0} y={row.y + 10}>{row.label}</text>)}
          </svg>
        ) : null}
        <div className="chart-heat-scroll">
          <svg width={svgWidth} height={svgHeight} role="presentation" onPointerLeave={() => setHover(null)}>
          {cells.map(cell => (
            <g key={`${cell.series}:${cell.slot}`} onPointerEnter={() => setHover({ series: cell.series, slot: cell.slot })}>
              <rect className="chart-cell" data-step={heatStep(cell.value, thresholds)}
                data-hovered={hover?.series === cell.series && hover?.slot === cell.slot ? 'true' : undefined}
                x={cell.x} y={cell.y} width={cell.w} height={cell.h} rx={calendar ? 2 : Math.min(6, Math.min(cell.w, cell.h) / 5)} />
              {cell.w >= 40 && cell.value ? <text className="chart-cell-value" x={cell.x + cell.w / 2} y={cell.y + cell.h / 2 + 4} textAnchor="middle">{readShort(cell.value)}</text> : null}
            </g>
          ))}
          {colLabels.map(column => <text key={`${column.label}:${column.x}`} className="chart-tick" x={column.x} y={svgHeight - 3}>{column.label}</text>)}
        </svg>
        </div>
      </div>
      <div className="chart-heat-legend" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map(step => <span key={step} className="chart-heat-key" data-step={step} />)}
        <span>More</span>
      </div>
    </div>
  );
}

const MARKS = new Map<string, ChartMark>([
  ['line', { label: 'Line', icon: 'ChartLine', frame: 'cartesian', edge: 'point', stacked: false, baseline: true, zero: unlessBaselined, draw: lineOrArea(false) }],
  ['area', { label: 'Area', icon: 'ChartArea', frame: 'cartesian', edge: 'point', stacked: true, baseline: true, zero: unlessBaselined, draw: lineOrArea(true) }],
  ['sparkline', { label: 'Sparkline', icon: 'Activity', frame: 'cartesian', edge: 'point', stacked: false, bare: true, draw: lineOrArea(true) }],
  ['bar', { label: 'Bars', icon: 'ChartColumn', frame: 'cartesian', edge: 'band', stacked: false, draw: bars(false) }],
  ['stacked-bar', { label: 'Stacked bars', icon: 'ChartColumnStacked', frame: 'cartesian', edge: 'band', stacked: true, draw: bars(true) }],
  ['donut', { label: 'Ring', icon: 'ChartPie', frame: 'box', draw: rings(false), ownReadout: true }],
  ['heatmap', { label: 'Heat map', icon: 'Grid3x3', frame: 'box', draw: Heatmap }],
  ['pie', { label: 'Pie', icon: 'ChartPie', frame: 'box', draw: rings(true), ownReadout: true, needs: { categories: true } }],
  ['radial', { label: 'Rings', icon: 'ChartPie', frame: 'box', draw: Radial, ownReadout: true, needs: { categories: true } }],
  ['radar', { label: 'Radar', icon: 'Radar', frame: 'box', draw: Radar, needs: { categories: true } }],
  ['treemap', { label: 'Tiles', icon: 'LayoutGrid', frame: 'box', draw: Treemap, needs: { categories: true } }],
  ['ranked-bar', { label: 'Ranked bars', icon: 'ChartBarBig', frame: 'box', draw: RankedBar, needs: { categories: true } }],
  ['composed', { label: 'Bars and lines', icon: 'ChartNoAxesCombined', frame: 'cartesian', edge: 'band', stacked: false, zero: data => !data.series.some(isCandle), headline: 'close', pane: PANE_ROLES, paneTone: composedTone, legend: CANDLE_ROLES, draw: Composed }],
  ['candlestick', { label: 'Candlesticks', icon: 'ChartCandlestick', frame: 'cartesian', edge: 'band', stacked: false, zero: false, headline: 'close', needs: { roles: CANDLE_ROLES }, pane: PANE_ROLES, paneTone: candleTone, draw: Candlestick }],
  ['histogram', { label: 'Histogram', icon: 'ChartColumn', frame: 'cartesian', edge: 'band', stacked: false, needs: { bins: true }, draw: Histogram }],
  ['step-line', { label: 'Step line', icon: 'ChartLine', frame: 'cartesian', edge: 'point', stacked: false, bends: false, baseline: true, zero: unlessBaselined, draw: lineOrArea(false, 'step') }],
  ['step-area', { label: 'Step area', icon: 'ChartArea', frame: 'cartesian', edge: 'point', stacked: true, bends: false, baseline: true, zero: unlessBaselined, draw: lineOrArea(true, 'step') }],
]);

/** Adds a mark to every chart. Registering an id again replaces it. */
export const registerChartMark = (id: string, mark: ChartMark) => { MARKS.set(id, mark); };
/** The mark for an id; an id nobody registered draws as an area, never nothing. */
export const chartMark = (id: string | undefined): ChartMark => MARKS.get(id ?? 'area') ?? MARKS.get('area')!;
export const chartMarks = () => [...MARKS].map(([id, mark]) => ({ id, label: mark.label, icon: mark.icon, needs: mark.needs, bends: mark.frame === 'cartesian' && mark.edge === 'point' && mark.bends !== false }));
