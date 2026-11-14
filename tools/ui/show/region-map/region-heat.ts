// parts/ui/show/region-map/region-heat.ts
//
// PURPOSE
//   The pure part of the region map, with no React and no colours: a region map placement is DATA (which field of each
//   record names a region, which field holds the number, how the numbers of one region are combined), and this reads
//   records into one number per region and puts each number in one of a few heat steps. Tested alone, so every surface
//   that draws a region map gets the same answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is named here: not a body, a muscle, a court or a room. Regions, fields and the combining formula are DATA.
//      The formula is the chart family's own (chart-from-records.ts formulaOf), not a second list.
//   2. A region with no reading has no value and no step (null). An empty reading is never drawn as the lowest heat or as 0.
//   3. Steps run 0..steps-1 across [min, max] of the values given, or of the explicit domain. All values equal puts them
//      in the middle step, never a divide by zero. A value outside an explicit domain is held to its nearest end.

import { formulaOf, readPath, type ValueOf } from '../chart/chart-from-records.ts';

export interface RegionHeatDomain { min: number; max: number }

/** A region map placement row: how records become one number per region. */
export interface RegionMapPlacement {
  /** The field whose value names the region a record belongs to (matches a region id). */
  region_field: string;
  /** The number field to combine; left out, the records of a region are counted. */
  value_field?: string;
  /** A chart formula id (sum, count, average, most, least, first, latest); sum, or count when no value_field, when left out. */
  formula?: string;
  /** Fixed ends of the heat scale; left out, the least and most value present. */
  domain?: RegionHeatDomain;
}

const numberOf = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
};

/** One number per region id from records. A region no record names is left out of the answer (no reading). */
export function regionValuesFromRecords(
  records: readonly unknown[],
  placement: RegionMapPlacement,
  readField: ValueOf = (record, field) => readPath(record, [field]),
): Record<string, number> {
  const counting = placement.value_field === undefined;
  const formula = formulaOf(placement.formula, counting);
  const byRegion = new Map<string, { values: number[]; count: number }>();
  for (const record of records) {
    const region = readField(record, placement.region_field);
    if (typeof region !== 'string' || !region) continue;
    const slot = byRegion.get(region) ?? { values: [], count: 0 };
    slot.count += 1;
    if (!counting) {
      const value = numberOf(readField(record, placement.value_field as string));
      if (value !== null) slot.values.push(value);
    }
    byRegion.set(region, slot);
  }
  const answer: Record<string, number> = {};
  for (const [region, slot] of byRegion) {
    const value = formula.reduce(slot.values, slot.count);
    if (value !== null && Number.isFinite(value)) answer[region] = value;
  }
  return answer;
}

export function regionHeatSteps(
  values: Readonly<Record<string, number | null | undefined>>,
  steps: number,
  domain?: RegionHeatDomain,
): Record<string, number | null> {
  const count = Math.max(1, Math.floor(steps));
  const present = Object.values(values).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const min = domain?.min ?? Math.min(...present);
  const max = domain?.max ?? Math.max(...present);
  return Object.fromEntries(Object.entries(values).map(([id, value]) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [id, null];
    if (max === min) return [id, Math.floor((count - 1) / 2)];
    const held = Math.min(max, Math.max(min, value));
    return [id, Math.min(count - 1, Math.floor(((held - min) / (max - min)) * count))];
  }));
}
