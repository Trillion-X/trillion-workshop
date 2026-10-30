// tools/traffic-attribution/do-work/break-down-visits-and-sales.mjs
//
// The Workshop tool "Break down visitors, sign-ups and sales by where they came from". argv[2] is one JSON input:
//   { project: { id, label?, outcomes?: [{ id, label } | id], currency?, dimensions?: [{ id, label }] },
//     visits: [{ visitor, signals: { source?, utm_campaign?, <any key>: text } }],
//     conversions?: [{ visitor, outcome?, value? }], break_down_by? }
// Visits are first touches, one per visitor; a conversion counts toward its `outcome` (or the project's first
// outcome when it names none) and its value sums into revenue. Prints one JSON line: the columns, one row per value
// of the breakdown with raw numbers and display text, the visitor total, and every breakdown the visits allow.
import { buildTrackedProjectRecord } from '../read-data/registry.ts';
import { groupObserverFactsByProject, TRAFFIC_CONVERSION_KIND, TRAFFIC_OBSERVER_FACT_KIND } from './observe-traffic.ts';
import { availableDimensionIds, deriveProjection } from './derive-projection.ts';

export function breakDownVisitsAndSales(input) {
  const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!object(input) || !object(input.project)) throw new Error('project must say which project the visits belong to ({ id }).');
  const project = buildTrackedProjectRecord({ projectId: input.project.id, label: input.project.label, conversionMetrics: input.project.outcomes, currency: input.project.currency, dimensions: input.project.dimensions });
  if (!project) throw new Error('project.id must be letters, numbers, dots, dashes or underscores.');
  if (!Array.isArray(input.visits)) throw new Error('visits must be a list of { visitor, signals }.');
  const visits = input.visits.map(visit => ({ kind: TRAFFIC_OBSERVER_FACT_KIND, projectId: project.projectId, observer_id: String(visit?.visitor ?? ''), signals: object(visit?.signals) ? visit.signals : {} }));
  const conversions = (Array.isArray(input.conversions) ? input.conversions : []).map(conversion => ({
    kind: TRAFFIC_CONVERSION_KIND, projectId: project.projectId, observer_id: String(conversion?.visitor ?? ''),
    ...(typeof conversion?.outcome === 'string' ? { metric: conversion.outcome } : {}), ...(typeof conversion?.value === 'number' ? { value: conversion.value } : {}),
  }));
  const aggregate = groupObserverFactsByProject(visits, conversions)[project.projectId] ?? { kind: 'traffic-signals', rows: [] };
  const projection = deriveProjection(project, aggregate, typeof input.break_down_by === 'string' ? input.break_down_by : undefined);
  const [dimension, ...metrics] = projection.fields.descriptors;
  return {
    title: projection.views.views[0].label,
    break_down_by: { id: projection.initialViewId.replace(/^traffic-by-/, ''), label: dimension.label },
    columns: metrics.map(metric => ({ id: metric.id, label: metric.label })),
    rows: projection.records.map(record => ({ value: record.payload.label, numbers: record.payload.metrics, display: record.payload.display })),
    visitors: projection.totalEntities,
    can_break_down_by: availableDimensionIds(aggregate),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(breakDownVisitsAndSales(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
