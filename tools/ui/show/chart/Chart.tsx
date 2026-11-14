// parts/ui/show/chart/Chart.tsx
//
// PURPOSE
//   The one chart every Trillion screen draws: a frame measured in real pixels (crisp text and 2px lines at any width),
//   the y axis read as rounded ticks with horizontal gridlines only, x labels that never collide, reference lines (a
//   budget, a target) labelled where they start, and the plot drawn by the mark its data names (chart-marks.tsx).
//   Pointing, touching or using the arrow keys scrubs it: a crosshair (a column band for bars), the hovered points, a
//   tooltip card with every series and how the slot stands against each reference line, and optionally the headline
//   number following the scrub. Bars over categories name every bar, the name wrapped to the bar's width. Loading draws the frame with a shimmer, nothing counted draws one sentence where the
//   plot would be, one reading draws its point. Narrow frames move the y labels inside the plot and keep at most four
//   x labels; a sparkline draws only its line.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure drawing: no reads, no records; the caller (or chart-from-records.ts) hands it ChartData.
//   2. Every mark gets the same states, scrub, keyboard and tooltip; a mark never re-implements them.
//   3. Text wears text tokens; a series colour only marks identity (swatches, lines, bars, slices).
//   4. Nothing counted is said in words over the frame, never drawn as a flat line at zero.
//   5. Motion respects prefers-reduced-motion (screen-look chart.css): lines draw in, bars grow from the baseline, data
//      changes morph; with reduced motion everything is simply there.
//   Appearance: parts/screen-look/show/chart.css (`.chart-*`).
//   A mark that names its numbers (candlestick: open, high, low, close) is read in that order in the tooltip and has no total;
//   a mark whose y axis should not start at zero (prices) says so with `zero: false`; `data.fill` is the look of the areas.
//   Stock-chart interaction (ideas from TradingView, fey.com and Compound Planning): pointing draws a thin vertical guide and a
//   horizontal guide at the pointed value with its value tag on the axis edge (a key scrub guides the slot's own reading); a
//   series in a named `pane` (or a role the mark lists in `pane`, volume) is drawn as low bars in a strip of about a fifth of the
//   plot (22%) under the main plot on a scale of its own, toned rise or fall, sharing the x axis and the crosshair, and kept out of
//   the shared scale and totals (each pane name is its own strip); a `derived` series (moving average) is a
//   switch in the legend that shows or hides it.
//
// Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui, Apache-2.0, commit acdc998c): registry/charts/candlestick-chart.tsx (tooltip lists the four readings), chart-kit.tsx (fill looks); changes: roles and fills are data on the shared tooltip and root, no recharts.

import React from 'react';
import { extent, linear, nearestIndex, niceTicks, slotCentres, stack, valueCentres } from './chart-geometry';
import { bucketOf, changeWords, paneOf, valueReader } from './chart-from-records';
import { PaneBars, chartMark, roleSeries, seriesColor, type CartesianContext } from './chart-marks';
import { Button } from '../button';
import type { ChartData, ChartLine, ChartSeries, ChartSlot } from './chart-types';

export type ChartProps = {
  data: ChartData;
  /** The mark that draws it (a registered mark id); default area. */
  mark?: string;
  /** What the chart is about, read aloud. */
  label: string;
  /** Plot height in pixels (default 240; a sparkline 40). */
  height?: number;
  state?: 'ready' | 'loading' | 'error';
  empty?: { title?: string; description?: string };
  /** Words when it could not be read. */
  error?: string;
  /** A heading over the plot: its name, its number and a line under the number. */
  title?: string;
  value?: string;
  detail?: string;
  /** The heading number follows the scrub (the slot's total), as a stat card does. */
  follow?: boolean;
  /** A press on a slot (to drill into it). */
  onSlot?: (index: number, slot: ChartSlot) => void;
  /** Controls drawn beside the heading (bucket switch, roll up). */
  controls?: React.ReactNode;
  /** Only the marks, no axes, grid or labels (a glyph beside words); a mark may ask for this itself (sparkline). */
  bare?: boolean;
  className?: string;
};

const DEFAULT_WIDTH = 560;
const AXIS_FONT_WIDTH = 6.6;
const LABEL_CHAR_WIDTH = 6.2;
const LABEL_LINES = 3;
const LABEL_LINE_HEIGHT = 13;
/** One pane's share of the plot height, the most all panes take together, and the gap between strips. */
const PANE_SHARE = 0.22;
const PANE_MOST = 0.45;
const PANE_GAP = 6;
/** The room opened at a numeric axis' middle (a book's mid price), in pixels. */
const MID_GAP = 10;

/** A category's name in lines of at most `perLine` characters, at most `most` lines; a word longer than a line keeps
 *  its own line, and words past the last line end it with an ellipsis (the tooltip names it whole). */
export function wrapWords(label: string, perLine: number, most: number): string[] {
  const lines: string[] = [];
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]} ${word}`.length <= perLine) lines[last] = `${lines[last]} ${word}`;
    else lines.push(word);
  }
  if (lines.length <= most) return lines;
  const kept = lines.slice(0, most);
  kept[most - 1] = `${kept[most - 1].slice(0, Math.max(1, perLine - 1))}…`;
  return kept;
}

/** The room kept between two x labels, in pixels. */
const LABEL_GAP = 8;

/** The widest unbroken run of a label, in characters: a name wraps at spaces, so this is the least width it can have. */
const longestWord = (label: string) => Math.max(1, ...label.split(/\s+/).map(word => word.length));

/**
 * Which labels of a band or category axis can be shown without touching: every k-th, the smallest k for which each shown
 * label and the next shown one (k slots on) keep LABEL_GAP between their estimated widths (`widths`, in pixels, centred on
 * their slots of width `slot`). 1 shows them all. Pure, so it can be tested.
 */
export function labelStride(widths: readonly number[], slot: number): number {
  const count = widths.length;
  if (count < 2 || !(slot > 0)) return 1;
  for (let k = 1; k < count; k += 1) {
    let clear = true;
    for (let at = 0; at + k < count && clear; at += k) clear = (widths[at] + widths[at + k]) / 2 + LABEL_GAP <= k * slot;
    if (clear) return k;
  }
  return count;
}

/**
 * Which labels of an axis whose slots sit at uneven places (a price axis, categories on a line) can be shown without touching:
 * walking from the left, a label is kept when its box (`[left, right]` in pixels, where it is really drawn, anchored or centred)
 * starts at least LABEL_GAP after the last kept box ends. The first is always kept; the answer is the kept indexes. Pure, so it can be tested.
 */
export function labelsClear(boxes: readonly (readonly [number, number])[]): Set<number> {
  const order = boxes.map((_, index) => index).sort((a, b) => boxes[a][0] - boxes[b][0]);
  const kept = new Set<number>();
  let edge = -Infinity;
  for (const index of order) {
    if (boxes[index][0] < edge + LABEL_GAP) continue;
    kept.add(index);
    edge = boxes[index][1];
  }
  return kept;
}

/**
 * The series that get a swatch in the legend, each with its place in the chart's series (its colour follows the place).
 * A series that plays a role its mark consumes (the roles it `needs`, reads in its `legend` or lays in a `pane`) is not a
 * swatch of its own: the mark draws it in its own tones and the readings line over the plot carries its value. Lines added
 * by `derive` and series that play no consumed role stay. Read from the mark's declarations, never its name.
 */
export function legendSeries(series: readonly ChartSeries[], mark: ReturnType<typeof chartMark>): { series: ChartSeries; index: number }[] {
  const consumed = new Set<string>([
    ...(mark.needs?.roles ?? []).map(role => role.id),
    ...(mark.frame === 'cartesian' ? [...(mark.legend ?? []).map(role => role.id), ...(mark.pane ?? [])] : []),
  ]);
  return series.map((one, index) => ({ series: one, index })).filter(({ series: one }) => one.derived || !one.role || !consumed.has(one.role));
}

function useWidth(): [React.RefCallback<HTMLElement>, number] {
  const [width, setWidth] = React.useState(DEFAULT_WIDTH);
  const observer = React.useRef<ResizeObserver | null>(null);
  const ref = React.useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!node || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(entries => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.current.observe(node);
  }, []);
  return [ref, width];
}

const isFilled = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/** The slot's total across series (or its one value). */
const totalAt = (data: ChartData, index: number): number | null => {
  const values = data.series.map(series => series.values[index]).filter(isFilled);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};

const slotWords = (data: ChartData, slot: ChartSlot | undefined) => {
  if (!slot) return '';
  const named = slot.t !== undefined && data.bucket ? bucketOf(data.bucket).long(slot.t) : slot.label;
  return slot.partial ? `${named} · so far` : named;
};

/** The reference lines worth drawing: one far above everything counted would flatten the plot, so it is said instead. */
function splitLines(lines: readonly ChartLine[], max: number): { drawn: ChartLine[]; said: ChartLine[] } {
  const drawn: ChartLine[] = [], said: ChartLine[] = [];
  for (const line of lines) (max > 0 && line.value > max * 3 ? said : drawn).push(line);
  return { drawn, said };
}

/** How far a place on a numeric axis is from the middle of it, as a percent of the middle (a bid below a book's mid price is negative); null when either is missing or the middle is zero. */
export function distanceFromMid(place: number | undefined, mid: number | undefined): number | null {
  return typeof place === 'number' && typeof mid === 'number' && mid !== 0 ? ((place - mid) / Math.abs(mid)) * 100 : null;
}

/**
 * What the tooltip lists for one slot: every series with a reading, largest first; a mark that names its numbers
 * (open, high, low, close) lists them in its own order under the names it gave, and has no total.
 */
export function slotRows(data: ChartData, roles: readonly { id: string; label: string }[] | undefined, rolePlayers: readonly (ChartSeries | undefined)[], index: number, panes: readonly ChartSeries[] = []) {
  if (roles) {
    return roles.flatMap((role, at) => {
      const series = rolePlayers[at];
      const reading = series?.values[index];
      return series && isFilled(reading) ? [{ id: role.id, label: role.label, value: reading, color: seriesColor(series, data.series.indexOf(series)) }] : [];
    });
  }
  const rows = data.series.map((series, at) => ({ id: series.id, label: series.label, value: series.values[index], color: seriesColor(series, at), pane: panes.includes(series) })).filter(row => isFilled(row.value));
  // The strip's readings (volume) come last: their size would otherwise put them over the price.
  if (rows.length > 1) rows.sort((a, b) => Number(a.pane) - Number(b.pane) || (b.value as number) - (a.value as number));
  return rows;
}

/**
 * The one quiet line over a plot whose mark names its numbers, at one slot: each named number by its first letter (O 182.1
 * H 184.0 L 181.2 C 183.5), the change from the first to the headline one (+0.8%), then the current value of every line
 * worked out from the others (a moving average), each carrying its line's colour. Rising or falling is read from those
 * roles alone (the headline against the first), so any mark that declares such roles gets it. Null with fewer than two readings.
 */
export function slotLegend(data: ChartData, roles: readonly { id: string; label: string }[], players: readonly (ChartSeries | undefined)[], headline: string | undefined, index: number, read: (value: number) => string) {
  const readings = roles.flatMap((role, at) => {
    const value = players[at]?.values[index];
    return isFilled(value) ? [{ id: role.id, short: role.label.charAt(0).toUpperCase(), label: role.label, value, text: read(value) }] : [];
  });
  if (readings.length < 2) return null;
  const first = readings[0];
  const last = readings.find(one => one.id === headline) ?? readings[readings.length - 1];
  const change = changeWords(first.value !== 0 ? ((last.value - first.value) / Math.abs(first.value)) * 100 : null);
  const tone: 'rise' | 'fall' = last.value < first.value ? 'fall' : 'rise';
  const lines = data.series.flatMap((series, at) => {
    const value = series.values[index];
    return series.derived && isFilled(value) ? [{ id: series.id, label: series.label, text: read(value), color: seriesColor(series, at) }] : [];
  });
  return { readings, tone, change, lines };
}

export function Chart({ data: given, mark: markId, label, height, state = 'ready', empty, error, title, value, detail, follow, onSlot, controls, className, bare: bareGiven }: ChartProps) {
  const mark = chartMark(markId);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set());
  // A series switched off in the legend is left out; the rest keep the colours they had.
  const data = React.useMemo(
    () => (hidden.size ? { ...given, series: given.series.map((one, at) => (one.slot === undefined ? { ...one, slot: at } : one)).filter(one => !hidden.has(one.id)) } : given),
    [given, hidden],
  );
  // The pane series (volume) are laid in their own strip; the mark and the shared scale see only the rest.
  const paneRoles = mark.frame === 'cartesian' ? mark.pane : undefined;
  const { mainData, paneGroups, panes } = React.useMemo(() => {
    const named = data.series.map(one => paneOf(one, paneRoles));
    if (!named.some(Boolean)) return { mainData: data, paneGroups: [] as { name: string; series: ChartSeries[] }[], panes: [] as ChartSeries[] };
    const groups: { name: string; series: ChartSeries[] }[] = [];
    data.series.forEach((one, at) => {
      const name = named[at];
      if (!name) return;
      const group = groups.find(each => each.name === name) ?? (groups[groups.push({ name, series: [] }) - 1]);
      group.series.push(one);
    });
    const main = data.series.map((one, at) => (one.slot === undefined ? { ...one, slot: at } : one)).filter((_, at) => !named[at]);
    return { mainData: { ...data, series: main }, paneGroups: groups, panes: groups.flatMap(group => group.series) };
  }, [data, paneRoles]);
  const bare = mark.frame === 'cartesian' && Boolean(bareGiven ?? mark.bare);
  const plotHeight = height ?? (bare ? 40 : 240);
  const [measure, width] = useWidth();
  const uid = `chart${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [hover, setHover] = React.useState<number | null>(null);
  const [pointerY, setPointerY] = React.useState<number | null>(null);
  const [boxHover, setBoxHover] = React.useState<{ series: number; slot: number } | null>(null);
  const [keyed, setKeyed] = React.useState(false);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const reader = valueReader(data.value_kind);
  const narrow = width < 480;

  const counted = data.series.some(series => series.values.some(value => isFilled(value) && value !== 0));
  const showState = state === 'loading' ? 'loading' : state === 'error' ? 'error' : !data.slots.length || !counted ? 'empty' : null;

  // ---- the x/y frame -------------------------------------------------------------------------------------------
  const frame = React.useMemo(() => {
    if (mark.frame !== 'cartesian') return null;
    const stacked = mark.stacked && mainData.series.length > 1;
    const layers = stacked ? stack(mainData.series.map(series => series.values)) : null;
    const values = layers ? layers.flatMap(layer => [...layer.upper, ...layer.lower]) : mainData.series.flatMap(series => series.values);
    const fromZero = typeof mark.zero === 'function' ? mark.zero(mainData) : mark.zero !== false;
    const [lo, hi] = extent(values, fromZero);
    const { drawn, said } = splitLines(mainData.lines ?? [], hi);
    const baseline = mark.baseline && typeof mainData.baseline === 'number' && Number.isFinite(mainData.baseline) ? mainData.baseline : null;
    const [dlo, dhi] = extent([lo, hi, ...drawn.map(line => line.value), ...(baseline === null ? [] : [baseline])], fromZero);
    const ticks = niceTicks(dlo, dhi, narrow ? 3 : 4);
    const domain: [number, number] = [ticks[0], ticks[ticks.length - 1]];
    const tickWords = ticks.map(tick => reader.short(tick));
    const inside = narrow || bare;
    const left = bare ? 2 : inside ? 4 : Math.ceil(Math.max(...tickWords.map(text => text.length)) * AXIS_FONT_WIDTH + 12);
    const plot = { left, right: width - (bare ? 2 : 8), top: bare ? 4 : 16, bottom: plotHeight - (bare ? 4 : 24) };
    // Each pane is a strip under the plot, PANE_SHARE of its height (the strips together never take more than PANE_MOST), the
    // first right under the main plot; the mark gets what is left above them.
    const stripHeight = Math.round((plot.bottom - plot.top) * Math.min(PANE_SHARE, PANE_MOST / Math.max(1, paneGroups.length)));
    const strips = bare ? [] : paneGroups.map((group, index) => {
      const bottom = plot.bottom - (paneGroups.length - 1 - index) * (stripHeight + PANE_GAP);
      return { name: group.name, series: group.series, top: bottom - stripHeight, bottom, most: Math.max(0, ...group.series.flatMap(one => one.values.filter(isFilled))) };
    });
    const markPlot = strips.length ? { ...plot, bottom: strips[0].top - 8 } : plot;
    const y = linear(domain, [markPlot.bottom, markPlot.top]);
    const ends = [plot.left + (mark.edge === 'point' && !bare ? 6 : 0), plot.right - (mark.edge === 'point' && !bare ? 6 : 0)] as const;
    // Slots that sit at a number (a price) are spaced by it, with room opened at the middle when the data names one; the rest are even.
    const ats = mark.edge === 'point' && mainData.slots.length > 1 && mainData.slots.every(one => typeof one.at === 'number') ? mainData.slots.map(one => one.at as number) : null;
    const { centres, slot, midX } = ats
      ? valueCentres(ats, ends[0], ends[1], mainData.mid, MID_GAP)
      : { ...slotCentres(mainData.slots.length, ends[0], ends[1], mark.edge), midX: null };
    // Bars over categories name every bar: each name wraps to its bar's width, at most LABEL_LINES lines, and the
    // frame grows under the plot for them. Moments along a time axis keep as many labels as fit side by side, evenly
    // spaced, never more than four on a narrow frame.
    const named = mark.edge === 'band' && !mainData.slots.some(one => typeof one.t === 'number');
    const widest = Math.max(1, ...mainData.slots.map(one => one.label.length)) * LABEL_CHAR_WIDTH + 14;
    const fit = Math.max(1, Math.floor((plot.right - plot.left) / widest));
    // Names that cannot wrap narrower than their longest word (a range like 258.8–267.1) are thinned to every k-th so none touch.
    const every = named ? labelStride(mainData.slots.map(one => longestWord(one.label) * LABEL_CHAR_WIDTH), slot) : Math.max(1, Math.ceil(mainData.slots.length / Math.min(fit, narrow ? 4 : fit)));
    const perLine = Math.max(4, Math.floor((slot - 6) / LABEL_CHAR_WIDTH));
    // A label whose centred box would cross the chart's left or right edge is anchored to start (or end) at that edge instead.
    // A time axis keeps the even spacing above; slots at a number (a price) or categories on a line are thinned by where they sit.
    const spaced = !named && !mainData.slots.some(one => typeof one.t === 'number');
    // Each box is where the label is really drawn: centred, or held to start at the first point / end at the last, or at the frame's edge.
    const clear = spaced ? labelsClear(mainData.slots.map((one, index): [number, number] => {
      const w = one.label.length * LABEL_CHAR_WIDTH;
      const c = centres[index];
      if (mark.edge === 'point' && index === 0) return [c, c + w];
      if (mark.edge === 'point' && index === mainData.slots.length - 1 && mainData.slots.length > 1) return [c - w, c];
      return c - w / 2 < 0 ? [0, w] : c + w / 2 > width ? [width - w, width] : [c - w / 2, c + w / 2];
    })) : null;
    const xLabels = mainData.slots.map((one, index) => ({ index, lines: named ? wrapWords(one.label, perLine, LABEL_LINES) : [one.label] })).filter(({ index }) => (clear ? clear.has(index) : index % every === 0)).map(({ index, lines }) => {
      const half = (Math.max(...lines.map(line => line.length)) * LABEL_CHAR_WIDTH) / 2;
      const centre = centres[index];
      const edge: 'start' | 'end' | 'middle' = centre - half < 0 ? 'start' : centre + half > width ? 'end' : 'middle';
      return { index, lines, edge, x: edge === 'start' ? 0 : edge === 'end' ? width : centre };
    });
    const below = (Math.max(1, ...xLabels.map(label => label.lines.length)) - 1) * LABEL_LINE_HEIGHT;
    const limit = drawn.length ? Math.max(...drawn.map(line => y(line.value))) : null;
    return { ticks, tickWords, plot, markPlot, strips, domain, y, xs: centres, slot, midX, baseY: y(Math.max(domain[0], Math.min(0, domain[1]))), xLabels, below, drawn, said, inside, limitY: limit, baselineY: baseline === null ? null : y(baseline) };
  }, [mark, mainData, paneGroups, width, plotHeight, narrow, bare, reader]);

  const move = (clientX: number, clientY: number) => {
    if (!frame || !svgRef.current || showState) return;
    const rect = svgRef.current.getBoundingClientRect();
    const index = nearestIndex(frame.xs, ((clientX - rect.left) / rect.width) * width);
    setKeyed(false);
    setHover(index);
    setPointerY(rect.height > 0 ? ((clientY - rect.top) / rect.height) * (plotHeight + frame.below) : null);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const count = data.slots.length;
    if (!count || showState) return;
    const step: Record<string, (at: number) => number> = {
      ArrowRight: at => Math.min(count - 1, at + 1), ArrowLeft: at => Math.max(0, at - 1), Home: () => 0, End: () => count - 1,
    };
    if (step[event.key]) {
      event.preventDefault();
      setKeyed(true);
      setPointerY(null);
      if (mark.frame === 'cartesian') setHover(at => step[event.key](at ?? count - 1));
      else setBoxHover(at => ({ series: at?.series ?? 0, slot: step[event.key](at?.slot ?? count - 1) }));
    } else if (event.key === 'Escape') { setHover(null); setBoxHover(null); setPointerY(null); }
    else if (event.key === 'Enter' && onSlot) {
      const at = mark.frame === 'cartesian' ? hover : boxHover?.slot ?? null;
      if (at !== null) onSlot(at, data.slots[at]);
    }
  };

  const hovered = mark.frame === 'cartesian' ? hover : boxHover?.slot ?? null;
  // A mark that names its numbers (open, high, low, close) has no total: its headline is the last one named that has a reading.
  const roles = mark.needs?.roles;
  const rolePlayers = React.useMemo(() => (roles ? roleSeries(data, roles) : []), [data, roles]);
  const slotTotal = (index: number): number | null => {
    // A mark that names the role of its headline (close) reads that series; the rest add up.
    const headline = mark.frame === 'cartesian' && mark.headline ? mainData.series.find(one => one.role === mark.headline) : undefined;
    if (headline && isFilled(headline.values[index])) return headline.values[index] as number;
    if (!roles) return totalAt(mainData, index);
    for (let at = rolePlayers.length - 1; at >= 0; at -= 1) {
      if (panes.includes(rolePlayers[at] as ChartSeries)) continue;
      const one = rolePlayers[at]?.values[index];
      if (isFilled(one)) return one;
    }
    return null;
  };
  const hoveredTotal = hovered !== null ? slotTotal(hovered) : null;
  const headValue = follow && hovered !== null && hoveredTotal !== null ? reader.full(hoveredTotal) : value;
  const headDetail = follow && hovered !== null ? slotWords(data, data.slots[hovered]) : detail;

  const tooltipRows = (index: number) => slotRows(data, roles, rolePlayers, index, panes);

  // The line over the plot comes from the roles the mark declares (its `legend`, else the roles it needs), not from its name;
  // a mark with positional roles reads them as the tooltip does, one that only lists them reads the series that say so.
  const legendRoles = mark.frame === 'cartesian' ? (mark.legend ?? roles)?.filter(role => !mark.pane?.includes(role.id)) : undefined;
  const legendPlayers = legendRoles?.map(role => {
    const at = roles ? roles.findIndex(one => one.id === role.id) : -1;
    return at >= 0 ? rolePlayers[at] : data.series.find(series => series.role === role.id);
  });
  const readingsAt = legendRoles && legendPlayers && !showState && !bare && data.slots.length
    ? slotLegend(data, legendRoles, legendPlayers, mark.frame === 'cartesian' ? mark.headline : undefined, hover !== null && hover < data.slots.length ? hover : data.slots.length - 1, reader.full)
    : null;
  const readings = readingsAt ? (
    <p className="chart-readings" data-tone={readingsAt.tone}>
      {readingsAt.readings.map(one => (
        <span key={one.id} className="chart-reading" title={one.label}><span className="chart-reading-name">{one.short}</span> <span className="chart-reading-value">{one.text}</span></span>
      ))}
      {readingsAt.change ? <span className="chart-reading chart-reading-change" data-tone={readingsAt.change.tone}>{readingsAt.change.text}</span> : null}
      {readingsAt.lines.map(one => (
        <span key={one.id} className="chart-reading chart-reading-line" style={{ '--series': one.color } as React.CSSProperties}><span className="chart-reading-name">{one.label}</span> <span className="chart-reading-value">{one.text}</span></span>
      ))}
    </p>
  ) : null;

  const readout = (index: number) => {
    const whole = slotTotal(index);
    return `${slotWords(data, data.slots[index])}: ${whole === null ? 'nothing counted' : reader.full(whole)}`;
  };

  const head = title || headValue || controls ? (
    <div className="chart-head">
      <div className="chart-head-words">
        {title ? <p className="chart-title">{title}</p> : null}
        {headValue ? <p className="chart-value">{headValue}</p> : null}
        {headDetail ? <p className="chart-detail">{headDetail}</p> : null}
      </div>
      {controls ? <div className="chart-controls">{controls}</div> : null}
    </div>
  ) : null;

  let body: React.ReactNode;
  if (showState) {
    body = (
      <div className="chart-state" data-state={showState} style={{ height: plotHeight }}>
        <div className="chart-state-grid" aria-hidden="true"><span /><span /><span /></div>
        {showState === 'loading' ? <div className="chart-shimmer" aria-hidden="true" /> : (
          <div className="chart-state-words">
            <p className="chart-state-title">{showState === 'error' ? error ?? 'This chart could not be read' : empty?.title ?? 'Nothing counted yet'}</p>
            {showState === 'empty' && empty?.description ? <p className="chart-state-description">{empty.description}</p> : null}
          </div>
        )}
      </div>
    );
  } else if (mark.frame === 'box') {
    body = (
      <>
        {mark.draw({ data, width, height: plotHeight, narrow, uid, hover: boxHover, setHover: at => { setKeyed(false); setBoxHover(at); }, read: reader.full, readShort: reader.short })}
        {boxHover && data.series.length > 1 ? (
          <p className="chart-readout">{`${data.series[boxHover.series]?.label ?? ''} · ${slotWords(data, data.slots[boxHover.slot])}: ${isFilled(data.series[boxHover.series]?.values[boxHover.slot]) ? reader.full(data.series[boxHover.series].values[boxHover.slot] as number) : 'nothing counted'}`}</p>
        ) : boxHover && data.series.length === 1 && !mark.ownReadout ? <p className="chart-readout">{readout(boxHover.slot)}</p> : null}
      </>
    );
  } else if (frame) {
    const ctx: CartesianContext = { data: mainData, xs: frame.xs, slot: frame.slot, y: frame.y, baseY: frame.baseY, plot: frame.markPlot, hover, uid, limitY: frame.limitY, baselineY: frame.baselineY };
    const at = hover !== null && hover < frame.xs.length ? hover : null;
    const side = at !== null && frame.xs[at] > width * 0.58 ? 'left' : 'right';
    const rows = at !== null ? tooltipRows(at) : [];
    const total = at !== null && !roles ? slotTotal(at) : null;
    // How far the pointed slot is from the middle of a numeric axis, as a percent of the middle (a book's mid price).
    const place = at !== null ? data.slots[at]?.at : undefined;
    const fromMid = distanceFromMid(place, mainData.mid);
    // The horizontal guide: where the pointer is (a key scrub: the slot's own reading), and what that height reads.
    let guide: { y: number; words: string } | null = null;
    if (at !== null && !bare) {
      const { strips, markPlot, domain } = frame;
      const strip = pointerY !== null ? [...strips].reverse().find(each => pointerY >= each.top) : undefined;
      if (pointerY !== null && strip) {
        const y = Math.min(strip.bottom, pointerY);
        guide = { y, words: valueReader('number').short(((strip.bottom - y) / (strip.bottom - strip.top)) * strip.most) };
      } else if (pointerY !== null) {
        const y = Math.max(markPlot.top, Math.min(markPlot.bottom, pointerY));
        guide = { y, words: reader.short(domain[0] + ((markPlot.bottom - y) / (markPlot.bottom - markPlot.top)) * (domain[1] - domain[0])) };
      } else {
        const reading = slotTotal(at);
        if (reading !== null) guide = { y: Math.max(markPlot.top, Math.min(markPlot.bottom, frame.y(reading))), words: reader.short(reading) };
      }
    }
    const tagWidth = guide ? Math.max(28, guide.words.length * AXIS_FONT_WIDTH + 12) : 0;
    const tagX = frame.inside ? frame.plot.right - tagWidth : Math.max(0, frame.plot.left - 2 - tagWidth);
    body = (
      <div className="chart-plot" style={{ height: plotHeight + frame.below }}>
        <svg
          ref={svgRef}
          className="chart-svg"
          width={width}
          height={plotHeight + frame.below}
          viewBox={`0 0 ${width} ${plotHeight + frame.below}`}
          role="presentation"
          onPointerMove={event => move(event.clientX, event.clientY)}
          onPointerDown={event => { if (event.pointerType !== 'mouse') event.currentTarget.setPointerCapture(event.pointerId); move(event.clientX, event.clientY); }}
          onPointerLeave={() => { setHover(null); setPointerY(null); }}
          onClick={() => { if (onSlot && hover !== null) onSlot(hover, data.slots[hover]); }}
          data-presses={onSlot ? 'true' : undefined}
        >
          {!bare ? frame.ticks.map((tick, index) => (
            <g key={tick}>
              <line className={tick === 0 ? 'chart-grid chart-zero' : 'chart-grid'} x1={frame.plot.left} x2={frame.plot.right} y1={frame.y(tick)} y2={frame.y(tick)} />
              {!frame.inside ? (
                <text className="chart-tick" x={frame.plot.left - 8} y={frame.y(tick) + 4} textAnchor="end">{frame.tickWords[index]}</text>
              ) : null}
            </g>
          )) : null}
          {at !== null && !bare && mark.edge === 'band'
            ? <rect className="chart-band" x={frame.xs[at] - frame.slot / 2} y={frame.plot.top - 6} width={frame.slot} height={frame.plot.bottom - frame.plot.top + 6} rx={6} /> : null}
          {frame.midX !== null && !bare ? <line className="chart-mid" x1={frame.midX} x2={frame.midX} y1={frame.plot.top} y2={frame.plot.bottom} /> : null}
          {at !== null && !bare ? <line className="chart-crosshair" x1={frame.xs[at]} x2={frame.xs[at]} y1={frame.plot.top - 6} y2={frame.plot.bottom} /> : null}
          {frame.strips.map(strip => (
            <React.Fragment key={strip.name}>
              <line className="chart-pane-rule" x1={frame.plot.left} x2={frame.plot.right} y1={strip.top - 3} y2={strip.top - 3} />
              <PaneBars name={strip.name} series={strip.series} xs={frame.xs} slot={frame.slot} top={strip.top} bottom={strip.bottom} hover={hover} tone={index => (mark.frame === 'cartesian' && mark.paneTone ? mark.paneTone(mainData, index) : 'rise')} />
            </React.Fragment>
          ))}
          {mark.draw(ctx)}
          {frame.drawn.map(line => (
            <g key={line.id} className="chart-ref" data-tone={line.tone ?? 'limit'}>
              <line x1={frame.plot.left} x2={frame.plot.right} y1={frame.y(line.value)} y2={frame.y(line.value)} />
            </g>
          ))}
          {/* Inside the plot, the value labels are drawn over the marks so a bar or a line never hides them. */}
          {!bare && frame.inside ? frame.ticks.map((tick, index) => (index > 0 ? (
            <g key={`inside:${tick}`}>
              <rect className="chart-tick-backdrop" x={frame.plot.left} y={frame.y(tick) - 16} width={String(frame.tickWords[index]).length * 7 + 6} height={14} rx={3} />
              <text className="chart-tick chart-tick-inside" x={frame.plot.left + 3} y={frame.y(tick) - 5} textAnchor="start">{frame.tickWords[index]}</text>
            </g>
          ) : null)) : null}
          {guide ? (
            <g className="chart-guide" aria-hidden="true">
              <line className="chart-crosshair chart-crosshair-h" x1={frame.plot.left} x2={frame.plot.right} y1={guide.y} y2={guide.y} />
              <rect className="chart-crosshair-tag" x={tagX} y={Math.max(0, Math.min(plotHeight - 18, guide.y - 9))} width={tagWidth} height={18} rx={4} />
              <text className="chart-crosshair-tag-text" x={tagX + tagWidth / 2} y={Math.max(0, Math.min(plotHeight - 18, guide.y - 9)) + 13} textAnchor="middle">{guide.words}</text>
            </g>
          ) : null}
          {!bare ? frame.xLabels.map(({ index, lines, edge, x }) => (
            <text key={index} className="chart-tick" x={x} y={plotHeight - 6} textAnchor={index === 0 && mark.edge === 'point' ? 'start' : index === data.slots.length - 1 && mark.edge === 'point' && data.slots.length > 1 ? 'end' : edge}>
              {lines.map((line, at) => <tspan key={at} x={x} dy={at ? LABEL_LINE_HEIGHT : 0}>{line}</tspan>)}
            </text>
          )) : null}
        </svg>
        {at !== null && !bare ? (
          <div className="chart-tooltip" data-side={side} data-pinned={narrow ? 'true' : undefined} style={narrow ? undefined : { left: frame.xs[at] }}>
            <p className="chart-tooltip-head">{slotWords(data, data.slots[at])}</p>
            {rows.length ? rows.map(row => (
              <p key={row.id} className="chart-tooltip-row">
                <span className="chart-swatch" style={{ '--series': row.color } as React.CSSProperties} />
                <span className="chart-tooltip-label">{row.label}</span>
                <span className="chart-tooltip-value">{reader.full(row.value as number)}</span>
              </p>
            )) : <p className="chart-tooltip-row"><span className="chart-tooltip-label">Nothing counted</span></p>}
            {fromMid !== null ? (
              <p className="chart-tooltip-row chart-tooltip-mid"><span className="chart-tooltip-label">From mid</span><span className="chart-tooltip-value">{changeWords(fromMid)?.text}</span></p>
            ) : null}
            {rows.length > 1 && total !== null ? (
              <p className="chart-tooltip-row chart-tooltip-total"><span className="chart-tooltip-label">Total</span><span className="chart-tooltip-value">{reader.full(total)}</span></p>
            ) : null}
            {total !== null ? (data.lines ?? []).map(line => {
              const over = total - line.value;
              return (
                <p key={line.id} className="chart-tooltip-row chart-tooltip-against" data-over={over > 0 ? 'true' : undefined}>
                  <span className="chart-tooltip-label">{line.label || 'Limit'}</span>
                  <span className="chart-tooltip-value">{over > 0 ? `${reader.full(over)} over` : `${reader.full(-over)} left`}</span>
                </p>
              );
            }) : null}
          </div>
        ) : null}
        {bare && at !== null ? <p className="chart-readout chart-readout-bare">{readout(at)}</p> : null}
      </div>
    );
  }

  const toggle = (id: string) => setHidden(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  // A line worked out from another (a moving average) is a switch; the series themselves are always drawn.
  const legendItems = legendSeries(given.series, mark);
  const legend = !showState && mark.frame === 'cartesian' && !bare && legendItems.length && given.series.length > 1 ? (
    <ul className="chart-legend">
      {legendItems.map(({ series, index }) => {
        const off = hidden.has(series.id);
        const face = (
          <>
            <span className="chart-swatch" style={{ '--series': seriesColor(series, index) } as React.CSSProperties} />
            <span className="chart-legend-label">{series.label}</span>
          </>
        );
        return (
          <li key={series.id} className="chart-legend-row" data-dashed={series.dashed ? 'true' : undefined} data-hidden={off ? 'true' : undefined}>
            {series.derived ? (
              <Button variant="plain" size="xs" className="chart-legend-toggle" active={!off} aria-pressed={!off} aria-label={`${series.label}, ${off ? 'hidden' : 'shown'}`} onClick={() => toggle(series.id)}>{face}</Button>
            ) : face}
          </li>
        );
      })}
    </ul>
  ) : null;

  const said = frame?.said.length && !showState && !bare ? (
    <p className="chart-said">{frame.said.map(line => `${line.label} ${reader.full(line.value)}`.trim()).join(' · ')}</p>
  ) : null;

  const references = frame?.drawn.length && !showState && !bare ? (
    <ul className="chart-reference-list" aria-label="Chart reference lines">
      {frame.drawn.map(line => (
        <li key={line.id} className="chart-reference-row" data-tone={line.tone ?? 'limit'}>
          <span className="chart-reference-rule" aria-hidden="true" />
          <span>{line.label || 'Limit'}</span>
          <strong>{reader.full(line.value)}</strong>
        </li>
      ))}
    </ul>
  ) : null;

  return (
    <div
      ref={measure}
      className={['chart', className].filter(Boolean).join(' ')}
      data-mark={markId ?? 'area'}
      data-narrow={narrow ? 'true' : undefined}
      data-bare={bare ? 'true' : undefined}
      data-fill={data.fill}
      role="group"
      aria-roledescription="chart"
      aria-label={label}
      tabIndex={showState ? undefined : 0}
      onKeyDown={onKeyDown}
      onBlur={() => { if (keyed) { setHover(null); setBoxHover(null); } }}
    >
      {head}
      {readings}
      {body}
      {legend}
      {references}
      {said}
      <span className="chart-sr" aria-live="polite">{keyed && hovered !== null ? readout(hovered) : ''}</span>
    </div>
  );
}
