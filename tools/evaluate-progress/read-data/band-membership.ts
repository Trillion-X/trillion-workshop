// tools/evaluate-progress/read-data/band-membership.ts
// Which half-open band [min, max) a number lands in. An omitted min is -Infinity, an omitted max is +Infinity, a non-finite value matches nothing, the first matching band wins.


export interface Band {
  min?: number;
  max?: number;
  payload?: unknown;
}

export function bandContains(value: number, band: Band | undefined): boolean {
  if (!band || !Number.isFinite(value)) return false;
  const min = typeof band.min === "number" ? (band.min as number) : Number.NEGATIVE_INFINITY;
  const max = typeof band.max === "number" ? (band.max as number) : Number.POSITIVE_INFINITY;
  return value >= min && value < max;
}

export function bandIndexOf(value: number, bands: ReadonlyArray<Band> | undefined): number {
  if (!Array.isArray(bands)) return -1;
  for (let i = 0; i < bands.length; i++) {
    if (bandContains(value, bands[i])) return i;
  }
  return -1;
}

export function bandPayloadOf(value: number, bands: ReadonlyArray<Band> | undefined): unknown {
  const i = bandIndexOf(value, bands);
  if (i < 0) return undefined;
  const band = (bands as ReadonlyArray<Band>)[i];
  return band.payload !== undefined ? band.payload : i;
}
