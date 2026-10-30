// tools/traffic-attribution/read-data/traffic-attribution.ts
//
// Funnel traffic/UTM attribution projection: turn observer facts into a
// human-facing traffic board by grouping observers on a DATA dimension
// (source/medium/campaign/referrer/...) and computing DATA metrics
// (visitors/conversions/conv-rate/...). The output is a complete
// visual-database decode input: addressed rows + field/view/action descriptor
// DATA. The reader owns grouping and formatting; visual-database owns row/table
// projection and row-open behavior (a translation boundary, L098).
//
// A new dimension or metric is a DATA row in TrafficAttributionConfig; this file
// names no source/medium/campaign/conversion literal. Conversion is a DATA fact
// path, not a hardcoded concept.
//
// Pure: no React, no I/O, no clock.

import {
  aggregateByDimension,
  type AddressedFact,
  type GroupMetric,
  type EntityDimension,
} from './aggregate-by-dimension.ts';

export type AttributionFieldFormat = {
  style: 'decimal' | 'currency' | 'percent';
  currency?: string;
  locale?: string;
  maximumFractionDigits?: number;
};

export type AttributionMetric = GroupMetric & { label: string; format?: AttributionFieldFormat };

export interface TrafficAttributionConfig {
  viewId: string;
  viewLabel: string;
  dimensionLabel: string;
  dimension: EntityDimension;
  metrics: AttributionMetric[];
}

/** One addressed visual-database row. Raw metrics remain numeric for downstream
 * computation; display values are preformatted from the metric's DATA format. */
export interface AttributionRecord {
  address: string;
  payload: {
    id: string;
    label: string;
    metrics: Record<string, number>;
    display: Record<string, string | number>;
  };
}

/** A visual-database field descriptor. `displayFormat` is owner DATA retained
 * alongside the generic descriptor; the renderer reads the already-formatted
 * value through `paths`, while raw values stay available under payload.metrics. */
export interface AttributionFieldDescriptor {
  id: string;
  label: string;
  role: string;
  paths: string[][];
  editable: false;
  sortable: boolean;
  displayFormat?: AttributionFieldFormat;
  domain?: { details: Array<{ id: string; label: string; paths: string[][] }> };
}

export interface AttributionFieldsDescriptor {
  kind: 'visual-database.fields';
  version: 2;
  descriptors: AttributionFieldDescriptor[];
}

/** The table view keeps generic visual-database row-open behavior. */
export interface AttributionViewDescriptor {
  id: string;
  label: string;
  kind: 'table';
  order: number;
  filters: [];
  projectionRules: [];
}

export interface AttributionViewsDescriptor {
  kind: 'visual-database.views';
  version: 2;
  views: AttributionViewDescriptor[];
}

export interface AttributionActionsDescriptor {
  kind: 'visual-database.actions';
  version: 2;
  actions: [];
}

export interface TrafficAttributionProjection {
  records: AttributionRecord[];
  fields: AttributionFieldsDescriptor;
  views: AttributionViewsDescriptor;
  actions: AttributionActionsDescriptor;
  initialViewId: string;
  boardInput: {
    records: { records: AttributionRecord[] };
    fields: AttributionFieldsDescriptor;
    views: AttributionViewsDescriptor;
    actions: AttributionActionsDescriptor;
  };
  totalEntities: number;
}

/** Project observer facts into addressed rows plus visual-database descriptors. */
export function projectTrafficAttribution(
  facts: AddressedFact[],
  config: TrafficAttributionConfig,
): TrafficAttributionProjection {
  const aggregation = aggregateByDimension(facts, {
    dimension: config.dimension,
    metrics: config.metrics.map((metric) => stripLabel(metric)),
    dimensionId: config.viewId,
  });

  const records: AttributionRecord[] = aggregation.groups.map((group) => {
    const display = Object.fromEntries(config.metrics.map((metric) => [
      metric.id,
      formatAttributionValue(group.metrics[metric.id], metric.format),
    ]));
    return {
      address: `traffic-attribution::${config.viewId}::${encodeURIComponent(group.dimensionKey)}`,
      payload: {
        id: group.dimensionKey,
        label: group.dimensionKey,
        metrics: group.metrics,
        display,
      },
    };
  });

  const fields: AttributionFieldsDescriptor = {
    kind: 'visual-database.fields',
    version: 2,
    descriptors: [
      {
        id: 'dimension',
        label: config.dimensionLabel,
        role: 'title',
        paths: [['payload', 'label']],
        editable: false,
        sortable: true,
      },
      ...config.metrics.map((metric): AttributionFieldDescriptor => ({
        id: metric.id,
        label: metric.label,
        role: 'metric',
        paths: [['payload', 'display', metric.id], ['payload', 'metrics', metric.id]],
        editable: false,
        sortable: true,
        ...(metric.format ? {
          displayFormat: metric.format,
          domain: { details: [{ id: 'format', label: metric.format.style, paths: [] }] },
        } : {}),
      })),
    ],
  };
  const views: AttributionViewsDescriptor = {
    kind: 'visual-database.views',
    version: 2,
    views: [{
      id: config.viewId,
      label: config.viewLabel,
      kind: 'table',
      order: 0,
      filters: [],
      projectionRules: [],
    }],
  };
  const actions: AttributionActionsDescriptor = {
    kind: 'visual-database.actions',
    version: 2,
    actions: [],
  };
  const boardInput = { records: { records }, fields, views, actions };

  return {
    records,
    fields,
    views,
    actions,
    initialViewId: config.viewId,
    boardInput,
    totalEntities: aggregation.totalEntities,
  };
}

/** Apply the exact Intl display DATA the owner supplied. No format means the
 * raw number remains numeric so visual-database can render and sort it directly. */
export function formatAttributionValue(
  value: number | undefined,
  format?: AttributionFieldFormat,
): string | number {
  if (value === undefined || !format) return value ?? 0;
  return new Intl.NumberFormat(format.locale ?? 'en-US', {
    style: format.style,
    ...(format.style === 'currency' ? { currency: format.currency ?? 'USD' } : {}),
    ...(format.maximumFractionDigits !== undefined
      ? { maximumFractionDigits: format.maximumFractionDigits }
      : {}),
  }).format(value);
}

/** Drop the display `label` so the metric is a pure GroupMetric for aggregation. */
function stripLabel(metric: AttributionMetric): GroupMetric {
  const { label: _label, ...rest } = metric;
  return rest as GroupMetric;
}
