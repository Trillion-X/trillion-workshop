// parts/ui/show/region-map/index.ts
//
// Barrel export for the region map: the component, and the pure functions that turn records into one number per region
// and one heat step per number.

export { RegionMap, REGION_HEAT_STEPS } from './RegionMap';
export type { MapRegion, RegionMapProps } from './RegionMap';
export { regionHeatSteps, regionValuesFromRecords } from './region-heat';
export type { RegionHeatDomain, RegionMapPlacement } from './region-heat';
