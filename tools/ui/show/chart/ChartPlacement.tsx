// parts/ui/show/chart/ChartPlacement.tsx
//
// PURPOSE
//   A chart placement drawn: records in, a chart placement DATA row (chart-types.ts) saying how to read them, the shared
//   Chart out. It also carries the moves every placed chart offers without its own code: roll a time chart up or down
//   (hour, day, week, month, any registered bucket), press a slot to drill into it at the next finer bucket, go back out,
//   and press a category (a bar, a slice) to hand that value to whoever placed the chart (a list filters by it).
//   ChartPlacements draws several placements as one grid (the first wide one across the row). A placement with `ranges`
//   (1W, 1M, 3M, 1Y, All; idea from TradingView and Compound Planning) also offers them as one segmented choice that narrows
//   the time axis to that window (measured back from the latest record), kept with the bucket; the chosen id is also handed to
//   `onPlacementChange` so a caller that owns the placement row (list-chart) writes it as the placement's `range`.
//   With `range_change` on the placement (or `show_change` on one range) each choice also carries its change under the label
//   (first to last value of the first series inside that range, as a signed percent toned rise or fall), the way TradingView does.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is named here: the placement names fields, marks, formulas and buckets; this only draws and steps.
//   2. Drilling is the same records read again over a narrower range at a finer bucket, never another screen.
//   3. Every control is a shared part (Button, SegmentedControl); appearance in screen-look chart.css.

import React from 'react';
import { Button } from '../button';
import { SegmentedControl } from '../segmented-control';
import { Chart } from './Chart';
import { bucketOf, chartBuckets, chartFromRecords, formulaAdditive, momentOf, paneOf, rangeChanges, readPath, valueReader, type ValueOf } from './chart-from-records';
import { chartMark, roleSeries } from './chart-marks';
import type { ChartData, ChartPlacement as Placement } from './chart-types';

export type ChartPlacementProps = {
  placement: Placement;
  records: readonly unknown[];
  answer?: unknown;
  readField?: ValueOf;
  groupLabel?: (value: string) => string;
  state?: 'ready' | 'loading' | 'error';
  error?: string;
  height?: number;
  /** A press on a category (a bar or slice with no time axis), with the group value it stands for. */
  onPick?: (value: string) => void;
  /** Controls the placer adds beside the heading (choose the mark, the field). */
  controls?: React.ReactNode;
  /** Where this placement was left (its bucket and how far it drilled), and who keeps it when it moves, so a placed
   *  chart opens where the person left it (parts/ui/show/placement-kept). */
  kept?: ChartKept;
  onKeep?: (kept: ChartKept) => void;
  /** Called with the whole placement when the person changes one of its choices on the chart (today the range). */
  onPlacementChange?: (placement: Placement) => void;
};

type Drill = { since: number; until: number; bucket: string };
/** What a placed chart keeps about itself: the bucket it is rolled up to, the range it shows and the slots it drilled into. */
export type ChartKept = { bucket?: string; range?: string; drills?: Drill[] };

const filledNumber = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const latestOf = (values: readonly (number | null)[] | undefined): number | undefined => {
  for (let at = (values?.length ?? 0) - 1; at >= 0; at -= 1) if (filledNumber(values![at])) return values![at] as number;
  return undefined;
};

/**
 * The big number over a chart. Read as data, never from a mark's name:
 *   1. A mark that names the role of its headline (`headline: 'close'`), else the last role it needs that is not laid in a
 *      pane, gives the latest reading of the series that plays that role (the close for candles), never a sum.
 *   2. Otherwise the series drawn on the plot (lines added by `derive` and pane series are left out) are added together
 *      when every formula the placement reads with is additive (sum, count); a formula that reads a level (average, most,
 *      least, first, latest: `additive: false`) gives the latest slot's value instead.
 */
export function headlineNumber(data: ChartData, placement: Pick<Placement, 'mark' | 'formula' | 'series'>): number | undefined {
  const mark = chartMark(placement.mark);
  const cartesian = mark.frame === 'cartesian' ? mark : null;
  const roles = mark.needs?.roles;
  if (cartesian?.headline) {
    const played = data.series.find(one => one.role === cartesian.headline);
    if (played) return latestOf(played.values);
  } else if (roles) {
    const players = roleSeries(data, roles);
    for (let at = players.length - 1; at >= 0; at -= 1) {
      const player = players[at];
      if (!player || (cartesian?.pane ?? []).includes(roles[at].id) || paneOf(player, cartesian?.pane)) continue;
      const found = latestOf(player.values);
      if (found !== undefined) return found;
    }
  }
  const paneRoles = cartesian?.pane;
  const plotted = data.series.filter(one => !one.derived && !paneOf(one, paneRoles));
  const formulas = Array.isArray(placement.series) && placement.series.length ? placement.series.map(row => row?.formula) : [placement.formula];
  const additive = formulas.every(formulaAdditive);
  const totals = data.slots.map((_, at) => plotted.reduce<number | null>((sum, series) => {
    const value = series.values[at];
    return filledNumber(value) ? (sum ?? 0) + value : sum;
  }, null));
  if (additive) {
    const filled = totals.filter((value): value is number => value !== null);
    return filled.length ? filled.reduce((sum, value) => sum + value, 0) : undefined;
  }
  return latestOf(totals);
}

/** The range a time chart covers, in words. */
function spanWords(data: ChartData): string | undefined {
  if (!data.bucket || !data.slots.length || data.slots[0].t === undefined) return undefined;
  const bucket = bucketOf(data.bucket);
  const first = data.slots[0], last = data.slots[data.slots.length - 1];
  return first === last ? bucket.long(first.t!) : `${bucket.name(first.t!)} – ${bucket.name(last.t!)}`;
}

export function ChartPlacement({ placement, records, answer, readField, groupLabel, state, error, height, onPick, controls, kept, onKeep, onPlacementChange }: ChartPlacementProps) {
  const [bucket, setBucketNow] = React.useState<string | undefined>(kept?.bucket);
  const [drills, setDrillsNow] = React.useState<Drill[]>(Array.isArray(kept?.drills) ? kept!.drills! : []);
  const [range, setRangeNow] = React.useState<string | undefined>(kept?.range);
  const setBucket = (next: string) => { setBucketNow(next); onKeep?.({ bucket: next, range, drills }); };
  const setRange = (next: string) => { setRangeNow(next); onKeep?.({ bucket, range: next, drills }); onPlacementChange?.({ ...placement, range: next }); };
  const setDrills = (change: (list: Drill[]) => Drill[]) => { const next = change(drills); setDrillsNow(next); onKeep?.({ bucket, range, drills: next }); };
  const drill = drills[drills.length - 1];
  const shownBucket = drill?.bucket ?? bucket ?? placement.over?.bucket;
  const data = React.useMemo(
    () => chartFromRecords({ placement, records, answer, readField, groupLabel, bucket: shownBucket, range, since: drill?.since, until: drill?.until }),
    [placement, records, answer, readField, groupLabel, shownBucket, range, drill],
  );
  const plotted = headlineNumber(data, placement);
  const fromAnswer = placement.headline_path ? readPath(answer, placement.headline_path) : undefined;
  const current = typeof fromAnswer === 'number' && Number.isFinite(fromAnswer) ? fromAnswer : undefined;
  const reader = valueReader(data.value_kind);
  const periodStart = placement.over?.since_path ? momentOf(readPath(answer, placement.over.since_path)) : null;
  const periodThrough = placement.over?.through_path ? momentOf(readPath(answer, placement.over.through_path)) : null;
  const span = !drill && periodStart !== null && periodThrough !== null
    ? `${bucketOf('day').name(periodStart)} – ${bucketOf('day').name(periodThrough)}`
    : spanWords(data);
  const detail = drill ? span : [placement.description ?? span, current !== undefined && plotted !== undefined && Math.abs(current - plotted) >= 0.015 ? `Bars shown: ${reader.full(plotted)}` : null].filter(Boolean).join(' · ') || undefined;
  const offered = placement.over ? (placement.over.buckets ?? chartBuckets().map(one => one.id)) : [];
  const onSlot = (index: number) => {
    const slot = data.slots[index];
    if (!slot) return;
    if (placement.over && slot.t !== undefined && slot.until !== undefined) {
      const finer = bucketOf(shownBucket).finer;
      if (finer && offered.includes(finer)) setDrills(list => [...list, { since: slot.t!, until: slot.until!, bucket: finer }]);
      return;
    }
    onPick?.(slot.key);
  };
  const ranges = placement.over && !drill && Array.isArray(placement.ranges) ? placement.ranges.filter(one => one && one.id) : [];
  const changes = React.useMemo(
    () => (ranges.length > 1 ? rangeChanges({ placement, records, answer, readField, groupLabel, bucket: shownBucket }) : {}),
    [placement, records, answer, readField, groupLabel, shownBucket, ranges.length],
  );
  const chosen = range ?? placement.range;
  const shownRange = ranges.some(one => one.id === chosen) ? chosen! : (ranges.find(one => !one.since && !one.days) ?? ranges[0])?.id;
  const timeControls = placement.over ? (
    <>
      {ranges.length > 1 && shownRange ? (
        <SegmentedControl className="chart-ranges" ariaLabel="How much to show" items={ranges.map(one => ({ id: one.id, label: one.label, note: changes[one.id]?.text, noteTone: changes[one.id]?.tone }))} value={shownRange} onValueChange={setRange} />
      ) : null}
      {drills.length ? (
        <Button variant="plain" size="xs" className="chart-step" onClick={() => setDrills(list => list.slice(0, -1))}>Back</Button>
      ) : offered.map(id => (
        <Button key={id} variant="plain" size="xs" className="chart-step" active={id === shownBucket} aria-pressed={id === shownBucket} onClick={() => setBucket(id)}>
          {bucketOf(id).label}
        </Button>
      ))}
    </>
  ) : null;
  return (
    <Chart
      data={data}
      mark={placement.mark}
      label={placement.title ?? placement.id}
      title={placement.title}
      value={current !== undefined && !drill ? reader.full(current) : plotted === undefined ? undefined : reader.full(plotted)}
      detail={detail}
      follow
      height={height}
      state={state}
      error={error}
      empty={placement.empty}
      onSlot={placement.over || onPick ? onSlot : undefined}
      controls={timeControls || controls ? <>{timeControls}{controls}</> : undefined}
    />
  );
}

/** Several placements as one grid: wide placements span the row, the rest share it two or three across by width. */
export function ChartPlacements({ placements, ...rest }: Omit<ChartPlacementProps, 'placement'> & { placements: readonly Placement[] }) {
  if (!placements.length) return null;
  return (
    <div className="chart-cards">
      {placements.map(placement => (
        <div key={placement.id} className="chart-card" data-wide={placement.wide ? 'true' : undefined}>
          <ChartPlacement placement={placement} {...rest} />
        </div>
      ))}
    </div>
  );
}

/** A list with its charts over it: the charts, then the list kept at a usable height, scrolling together. Without
 *  charts the list is drawn as it was. */
export function ChartsOver({ placements, records, answer, children }: { placements: readonly Placement[]; records: readonly unknown[]; answer?: unknown; children: React.ReactNode }) {
  if (!placements.length) return <>{children}</>;
  return (
    <>
      <div className="record-set-charts"><ChartPlacements placements={placements} records={records} answer={answer} /></div>
      <div className="record-set-list-under-charts">{children}</div>
    </>
  );
}
