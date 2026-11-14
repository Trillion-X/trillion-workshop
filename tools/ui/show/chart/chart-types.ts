// parts/ui/show/chart/chart-types.ts
//
// PURPOSE
//   The shapes every chart is drawn from. ChartData is what a chart shows (its slots along the x axis, its series of
//   numbers, its reference lines); a ChartPlacement is the DATA row that makes ChartData from records (which field is
//   read, how records are grouped, which formula reduces each group, over what time bucket). The same placement draws
//   a list's chart view, a screen's charts and a chart placed on any arrangement.
//
//   Added fields, every one optional and every one DATA: ChartSeries.draw / role, ChartData.curve / fill, and on a
//   placement `series` (several readings), `bins` (slots are ranges of a reading), `derive` (lines added from the
//   numbers: moving-average, running-total, change-percent, difference, share), `curve` and `fill`. Stock-chart
//   interaction fields: ChartSeries.pane (a named pane: any name but 'main' is a low strip under the plot, volume under a
//   price) and `ranges` with the chosen `range` (1W, 1M, 3M, YTD, 1Y, All as a segmented choice that narrows the time axis).
//
// Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui, Apache-2.0, commit acdc998c): the chart kinds and options in registry/charts/*.tsx; changes: written as DATA fields on Trillion's one chart engine, no Spectrum code, colours or data kept.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every open set here is a string looked up in a map at draw time (marks, formulas, value kinds, buckets, tones),
//      never a closed union: a new mark, formula or kind of number is one registered entry, not an edit here.
//   2. A value is a number or null (nothing counted there); null is never drawn as zero.

/** One place along the x axis: a moment (t, epoch ms, for a time axis) or a category. */
export type ChartSlot = {
  key: string; label: string; t?: number; until?: number; partial?: boolean;
  /** Where the slot sits on a numeric axis (a price): set when the placement names an `order` that reads it. A chart whose slots all carry it spaces them by it, not evenly. */
  at?: number;
};

/** One series of numbers, one value per slot. `slot` picks its colour from the categorical order (0-based). */
export type ChartSeries = {
  id: string; label: string; values: (number | null)[]; slot?: number; tone?: string; dashed?: boolean;
  /** Inside a composed chart, the mark this series is drawn with (bar, line, area); left out, the first series is a bar and the rest lines. */
  draw?: string;
  /** What this series is to its mark (open, high, low, close for a candlestick); a mark reads series by role. */
  role?: string;
  /** The pane this series is drawn in. Left out (or 'main') it shares the main plot; any other name is its own low strip under the plot (volume under a price) with a scale of its own, sharing the x axis and the crosshair, and kept out of the main scale and the headline total. */
  pane?: string;
  /** How this series bends, over the chart's own: a key of the registered curves (a book of bids steps the other way from asks). */
  curve?: string;
  /** In a ranked-bar, the id or role of the series whose values set this series' bar length (a running total drawn while the amount is written). Left out, the bar follows its own values. */
  bar?: string;
  /** Worked out from another series (a moving average): the legend offers it as a switch to show or hide. */
  derived?: boolean;
  /** A tone per value, over the series' own colour (a bar that is late, a day that went well). */
  tones?: (string | null | undefined)[];
};

/** A reference line across the plot: a budget, a target, a limit. Labelled where it starts, never only in a legend. */
export type ChartLine = { id: string; label: string; value: number; tone?: string };

export type ChartData = {
  slots: ChartSlot[];
  series: ChartSeries[];
  lines?: ChartLine[];
  /** How a value reads (money, count, seconds, percent, number): a key of the value readers. */
  value_kind?: string;
  /** The bucket of a time axis (hour, day, week, month), when the slots are moments. */
  bucket?: string;
  /** How a line or area bends between its points: a key of the registered curves (monotone, linear, step). */
  curve?: string;
  /** How a filled mark is filled: gradient, solid, hatched, dotted, none, glow (the look gives each its paint). */
  fill?: string;
  /** The value a line or area is measured against (a portfolio's start): drawn as a quiet dashed line, the stroke and fill over it in the rise tone and under it in the fall tone. Already worked out from the placement's `baseline`. */
  baseline?: number;
  /** The middle of a numeric axis (a book's mid price), in the same units as the slots' `at`: a quiet rule with a visible gap either side, and the distance from it said in the tooltip. Already worked out from the placement's `mid` / `mid_path`. */
  mid?: number;
};

/** One more reading drawn on a chart: its own field, formula, mark, role and tone. */
export type ChartSeriesRow = {
  reading: string; label?: string; formula?: string; draw?: string; role?: string; tone?: string; dashed?: boolean;
  /** The pane the series is drawn in (see ChartSeries.pane). */
  pane?: string;
  /** Only records where the value at `where.path` is one of `where.one_of` count toward this series (bids and asks out of one list of levels); a slot where none pass holds nothing, not zero. */
  where?: { path: string[]; one_of: unknown[] };
  /** How this series bends (see ChartSeries.curve). */
  curve?: string;
  /** See ChartSeries.bar. */
  bar?: string;
};

/** A length of time as DATA; the parts add together (a week and two days is weeks 1, days 2). */
export type ChartDuration = { days?: number; weeks?: number; months?: number; years?: number };

/**
 * One choice of how much of the time axis to show: "1W", "3M", "YTD", "All". It counts back from the latest record, never
 * from today: `days` is a number of days, `since` is a calendar length (a ChartDuration) or 'year-start' (the first of
 * January of the latest record's year). A choice with neither is everything. `show_change` writes the first series' change over the choice
 * (first to last value inside it, as a percent) under its label; false keeps it off when the placement asks for `range_change`.
 */
export type ChartRange = { id: string; label: string; days?: number; since?: ChartDuration | 'year-start'; show_change?: boolean };

/** One line added from the numbers already drawn: a key of the registered derivations, with its own options. */
export type ChartDerivationRow = {
  kind: string; window?: number; of?: string; label?: string; draw?: string; dashed?: boolean;
  /** The id the line is known by (so a ranked-bar series can name it as its `bar`). */
  id?: string;
  /** 'end' works from the last slot back (a total that grows outward from a mid price on the bid side); left out, from the first. */
  from?: string;
  /** The result is drawn in place of the series it is made from, keeping its id, role, tone and mark (a depth chart shows the cumulative amount, not each level's). */
  instead?: boolean;
};

/** A reference line as DATA: a fixed value, or one line per row found at `from` in the records' answer. */
export type ChartLineRow = {
  id?: string; label?: string; value?: number; tone?: string;
  from?: string[]; value_path?: string[]; label_path?: string[];
  /** Shown only while the chart's bucket is this one (a day budget on a daily chart); `bucket_path` reads it per row. */
  bucket?: string; bucket_path?: string[];
  /** Rows at `from` kept only when the value at `where.path` is one of `where.one_of`. */
  where?: { path: string[]; one_of: unknown[] };
};

/** A chart as DATA: which records, which field, grouped how, reduced by which formula, drawn by which mark. */
export type ChartPlacement = {
  id: string;
  title?: string;
  description?: string;
  /** The mark that draws it: a key of the registered marks (line, area, bar, stacked-bar, donut, heatmap, sparkline). */
  mark: string;
  /** Where the records are in the answer the chart reads (default: the records handed to it). */
  records_path?: string[];
  /** Records kept only when the value at `where.path` is one of `where.one_of`. */
  where?: { path: string[]; one_of: unknown[] };
  /** The field whose number is reduced; left out, records are counted. */
  reading?: string;
  /** The field whose value splits records: series on a time chart, slices or bars otherwise. */
  group?: string;
  /** How a group's numbers become one number: a key of the formulas (sum, count, average, most, least, latest). */
  formula?: string;
  /** A current total read from the answer, when daily records have a different freshness or coverage. */
  headline_path?: string[];
  /** A time axis: the date field and the bucket (hour, day, week, month). */
  over?: { field: string; bucket?: string; buckets?: string[]; since_path?: string[]; through_path?: string[] };
  /** At most this many groups are drawn; the rest are added together as one "Other". */
  limit?: number;
  /** How the groups of a category chart are laid out: a key of the registered orders (total, number, number-descending, name). An order that reads a number gives every slot its position `at`. Left out: largest first. */
  order?: string;
  /** The middle of the numeric axis: a number, or 'between' (halfway between where the first series ends and the second begins). */
  mid?: number | string;
  /** Or read the middle from the answer. */
  mid_path?: string[];
  lines?: ChartLineRow[];
  value_kind?: string;
  /** Several readings on one chart, each reduced by its own formula (open and close, bids and asks, desktop and mobile). */
  series?: ChartSeriesRow[];
  /** Slots become ranges of `reading` (a histogram): `count` ranges, or ranges `width` wide; each counts records. */
  bins?: { count?: number; width?: number };
  /** Lines added from the numbers drawn: a moving average, a running total, change from the start, change from the last slot. */
  derive?: ChartDerivationRow[];
  /** How a line or area bends: a key of the registered curves (monotone, linear, step). */
  curve?: string;
  /** How a filled mark is filled: gradient, solid, hatched, dotted, none, glow. */
  fill?: string;
  /** How much of a time axis to show, as a segmented choice (1W, 1M, 3M, YTD, 1Y, All): each counts back from the latest record; the choice is kept like the bucket. */
  ranges?: ChartRange[];
  /** The id of the `ranges` choice that is chosen (the person's pick is written here by the placer through onPlacementChange). */
  range?: string;
  /** Every choice of `ranges` shows its change (a `show_change: false` choice opts out): TradingView's percent under each range. */
  range_change?: boolean;
  /** A value a line or area is measured against, or 'first' for the first value drawn: a quiet dashed line there, stroke and fill over it in the rise tone and under it in the fall tone (a gradient split at its y; a portfolio against its start). */
  baseline?: number | 'first';
  /** The last slot is still filling (today, this month): drawn hatched and called "so far". */
  partial_last?: boolean;
  /** A chart that spans the whole row of a grid of charts. */
  wide?: boolean;
  empty?: { title?: string; description?: string };
};
