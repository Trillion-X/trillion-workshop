// parts/ui/show/chart/list-chart.tsx
//
// PURPOSE
//   A list's records drawn as a chart placement the person tunes on the chart (offer-chart-view.tsx offers it to every list;
//   this file is fetched the first time a list is drawn as a chart, never with the page).
//   Where the chart's choices live: with the saved view that is open (a view whose display is the chart carries them in
//   context.settings and writes changes back through context.saveSettings), else in the person's own choice for the list.
//   The choices follow the mark: a mark that needs named numbers (candlesticks) gets one Number choice for each, a mark that cuts one
//   number into ranges (a histogram) gets the number it cuts, and a line mark gets Line (how it bends); Look and Add a line suit every mark.
//   A chart over time offers 1M 3M 6M YTD 1Y All (DEFAULT_RANGES) unless the placement names its own ranges; the chosen one is
//   written back as the placement's `range`.
//
// Adapted from Spectrum UI (https://github.com/arihantcodes/spectrum-ui, Apache-2.0, commit acdc998c): registry/charts/chart-kit.tsx (the choice of fills and of added lines); changes: the choices are Trillion dropdowns over the open registries, written to the chart placement row.

import React from 'react';
import { Dropdown } from '../dropdown';
import type { RecordViewContext } from '../record-views/record-views';
import { ChartPlacement } from './ChartPlacement';
import { keepChartChoice, useChartChoice } from './chart-choice';
import { DEFAULT_RANGES, chartDerivations, chartFormulas, isDateField, isNumberField, groupsBy, startingPlacement } from './chart-from-records';
import { chartCurves } from './chart-geometry';
import { chartMarks } from './chart-marks';
import type { ChartPlacement as Placement } from './chart-types';

/** How a filled mark can look; the look sheet draws each (chart.css, [data-fill]). */
const LOOKS = [
  { value: '', label: 'Gradient' }, { value: 'solid', label: 'Solid' }, { value: 'hatched', label: 'Hatched' },
  { value: 'dotted', label: 'Dotted' }, { value: 'glow', label: 'Glow' }, { value: 'none', label: 'Outline' },
];
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function ListChart({ context }: { context: RecordViewContext }) {
  const { fields, records, label } = context;
  const key = `chart-view:${label}`;
  const kept = useChartChoice<Placement>(key);
  // A saved view that is drawn as a chart carries its placement (context.settings); with none open, the person's own choice for this list.
  const given = context.settings as Placement | undefined;
  const placement: Placement = given && typeof given === 'object' && typeof given.mark === 'string' ? given
    : kept && typeof kept === 'object' && typeof kept.mark === 'string' ? kept : startingPlacement(fields, label);
  const byId = React.useMemo(() => new Map(fields.map(field => [field.id, field])), [fields]);
  const readField = React.useCallback((record: unknown, id: string) => {
    const field = byId.get(id);
    if (!field) return undefined;
    if (field.factValue) return field.factValue(record);
    return field.read ? field.read(record) : (record as Record<string, unknown> | null)?.[id];
  }, [byId]);
  const groupLabel = React.useCallback((value: string) => (placement.group ? byId.get(placement.group)?.values?.[value]?.label ?? value : value), [byId, placement.group]);
  const change = (next: Partial<Placement>) => {
    const whole = { ...placement, ...next };
    if (context.saveSettings) context.saveSettings(whole as Record<string, unknown>);
    else void keepChartChoice(key, whole);
  };
  const number = placement.reading ? byId.get(placement.reading) : undefined;
  const choose = (choiceLabel: string, value: string, items: { value: string; label: string; icon?: string }[], onChange: (value: string) => void) => (
    <Dropdown size="sm" label={choiceLabel} value={value} items={items} onValueChange={onChange} />
  );
  const mark = chartMarks().find(one => one.id === placement.mark);
  const roles = mark?.needs?.roles;
  const numbers = fields.filter(isNumberField).map(field => ({ value: field.id, label: field.label }));
  const roleReading = (role: string) => placement.series?.find(row => row.role === role)?.reading ?? '';
  // One reading per role, kept in the mark's order; a role left empty has no row, so the mark draws without it.
  const setRole = (role: string, reading: string) => {
    const rows = (roles ?? []).flatMap(one => {
      const picked = one.id === role ? reading : roleReading(one.id);
      return picked ? [{ reading: picked, role: one.id, label: one.label, formula: one.formula }] : [];
    });
    change({ series: rows.length ? rows : undefined });
  };
  const setMark = (id: string) => {
    const next = chartMarks().find(one => one.id === id);
    change({
      mark: id,
      bins: next?.needs?.bins ? placement.bins ?? {} : undefined,
      reading: next?.needs?.bins ? placement.reading ?? numbers[0]?.value : placement.reading,
      series: next?.needs?.roles ? placement.series : placement.series?.filter(row => !row.role),
    });
  };
  const controls = (
    <>
      {choose('Drawn as', placement.mark, chartMarks().map(one => ({ value: one.id, label: one.label, icon: one.icon })), setMark)}
      {roles
        ? roles.map(role => <React.Fragment key={role.id}>{choose(role.label, roleReading(role.id), [{ value: '', label: 'Nothing' }, ...numbers], reading => setRole(role.id, reading))}</React.Fragment>)
        : choose('Number', placement.reading ?? '', [...(mark?.needs?.bins ? [] : [{ value: '', label: 'How many' }]), ...numbers],
          reading => change(reading ? { reading, formula: placement.formula === 'count' ? 'sum' : placement.formula, value_kind: byId.get(reading)?.kind === 'money' ? 'money' : undefined } : { reading: undefined, formula: 'count', value_kind: undefined }))}
      {placement.reading && !roles && !mark?.needs?.bins ? choose('Formula', placement.formula ?? 'sum', chartFormulas().filter(one => !one.counts).map(one => ({ value: one.id, label: one.label })), formula => change({ formula })) : null}
      {choose('Split by', placement.group ?? '', [{ value: '', label: 'Nothing' }, ...fields.filter(groupsBy).map(field => ({ value: field.id, label: field.label }))], group => change({ group: group || undefined }))}
      {mark?.bends ? choose('Line', placement.curve ?? 'monotone', chartCurves().map(id => ({ value: id, label: sentence(id) })), curve => change({ curve })) : null}
      {choose('Look', placement.fill ?? '', LOOKS, fill => change({ fill: fill || undefined }))}
      {choose('Add a line', placement.derive?.[0]?.kind ?? '', [{ value: '', label: 'Nothing' }, ...chartDerivations().map(one => ({ value: one.id, label: sentence(one.label) }))],
        kind => change({ derive: kind ? [{ kind }, ...(placement.derive ?? []).slice(1)] : (placement.derive ?? []).slice(1) }))}
    </>
  );
  return (
    <div className="chart-view">
      <ChartPlacement
        placement={{ ...placement, ranges: placement.over ? placement.ranges ?? DEFAULT_RANGES : placement.ranges, title: placement.title ?? (number ? number.label : label), value_kind: placement.value_kind ?? (number?.kind === 'money' ? 'money' : undefined) }}
        records={records}
        readField={readField}
        groupLabel={groupLabel}
        height={300}
        controls={context.readOnly ? undefined : controls}
        onPlacementChange={next => change({ range: next.range })}
      />
    </div>
  );
}
