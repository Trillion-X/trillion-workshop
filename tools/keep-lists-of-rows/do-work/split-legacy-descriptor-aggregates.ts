//
// Lossless owner-boundary split from legacy Visual Database aggregates into open
// independently addressed descriptor members. This file owns Visual Database
// Society spelling; the generic migration planner remains payload-agnostic.

import { spreadKeys } from './fractional-order';
import type { LegacyDescriptorAggregate } from './migrate-descriptor-aggregates';
import type { DescriptorKey } from '../read-data/addressed-descriptors';

type JsonObject = Record<string, unknown>;

export type VisualDatabaseLegacyAggregateKind = 'fields' | 'views' | 'grid-properties';

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (Array.isArray(value)) return value.map(clone) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clone(entry)]),
    ) as T;
  }
  return value;
}

function idOf(value: JsonObject, fallback: string): string {
  return typeof value.id === 'string' && value.id.trim() ? value.id.trim() : fallback;
}

function member(
  family: string,
  id: string,
  value: unknown,
  parent?: readonly { family: string; id: string }[],
): LegacyDescriptorAggregate['descriptors'][number] {
  const key: DescriptorKey = { family, id, ...(parent?.length ? { parent } : {}) };
  return { key, value };
}

function without(source: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !keys.includes(key))
      .map(([key, value]) => [key, clone(value)]),
  );
}

function splitFields(payload: unknown): LegacyDescriptorAggregate['descriptors'] {
  const descriptors = isRecord(payload) && Array.isArray(payload.descriptors)
    ? payload.descriptors.filter(isRecord)
    : [];
  const fieldOrders = spreadKeys(descriptors.length);
  return descriptors.flatMap((rawField, fieldIndex) => {
    const fieldId = idOf(rawField, `field-${fieldIndex}`);
    const rawDomain = isRecord(rawField.domain) ? rawField.domain : null;
    const values = rawDomain && Array.isArray(rawDomain.values)
      ? rawDomain.values.filter(isRecord)
      : [];
    const valueOrders = spreadKeys(values.length);
    const base = without(rawField, ['domain', 'order']);
    const domainWithoutValues = rawDomain ? without(rawDomain, ['values']) : null;
    const fieldValue = {
      ...base,
      order: fieldOrders[fieldIndex],
      ...(domainWithoutValues && Object.keys(domainWithoutValues).length > 0
        ? { domain: domainWithoutValues }
        : {}),
    };
    return [
      member('field', fieldId, fieldValue),
      ...values.map((value, valueIndex) => member(
        'field-domain-value',
        idOf(value, `value-${valueIndex}`),
        {
          ...without(value, ['order']),
          order: valueOrders[valueIndex],
        },
        [{ family: 'field', id: fieldId }],
      )),
    ];
  });
}

function splitColumns(
  rawColumns: unknown,
  viewId: string,
): LegacyDescriptorAggregate['descriptors'] {
  if (!isRecord(rawColumns)) return [];
  const rawOrder = Array.isArray(rawColumns.order)
    ? rawColumns.order.filter((value): value is string => typeof value === 'string' && !!value)
    : [];
  const widths = isRecord(rawColumns.widths) ? rawColumns.widths : {};
  const styles = isRecord(rawColumns.styles) ? rawColumns.styles : {};
  const hidden = new Set(
    Array.isArray(rawColumns.hidden)
      ? rawColumns.hidden.filter((value): value is string => typeof value === 'string' && !!value)
      : [],
  );
  const ids = [...new Set([
    ...rawOrder,
    ...Object.keys(widths),
    ...Object.keys(styles),
    ...hidden,
  ])];
  const orders = spreadKeys(ids.length);
  return ids.map((fieldId, index) => member(
    'view-column',
    fieldId,
    {
      fieldId,
      order: orders[index],
      ...(typeof widths[fieldId] === 'number' ? { width: widths[fieldId] } : {}),
      ...(hidden.has(fieldId) ? { hidden: true } : {}),
      ...(isRecord(styles[fieldId]) ? { style: clone(styles[fieldId]) } : {}),
    },
    [{ family: 'view', id: viewId }],
  ));
}

function splitViews(payload: unknown): LegacyDescriptorAggregate['descriptors'] {
  const rawViews = isRecord(payload) && Array.isArray(payload.views)
    ? payload.views.filter(isRecord)
    : [];
  const palette = isRecord(payload) && Array.isArray(payload.palette)
    ? payload.palette
    : [];
  const viewOrders = spreadKeys(rawViews.length);
  const descriptors = rawViews.flatMap((rawView, viewIndex) => {
    const viewId = idOf(rawView, `view-${viewIndex}`);
    const parent = [{ family: 'view', id: viewId }];
    const filters = Array.isArray(rawView.filters) ? rawView.filters.filter(isRecord) : [];
    const rulesValue = rawView.projectionRules ?? rawView.projection_rules;
    const rules = Array.isArray(rulesValue) ? rulesValue.filter(isRecord) : [];
    const positionsValue = rawView.canvasPositions ?? rawView.canvas_positions;
    const positions = isRecord(positionsValue) ? positionsValue : {};
    const filterOrders = spreadKeys(filters.length);
    const ruleOrders = spreadKeys(rules.length);
    const positionOrders = spreadKeys(Object.keys(positions).length);
    const base = {
      ...without(rawView, [
        'order',
        'filters',
        'projectionRules',
        'projection_rules',
        'columns',
        'gridStyle',
        'grid_style',
        'rowStyle',
        'row_style',
        'canvasPositions',
        'canvas_positions',
      ]),
      order: viewOrders[viewIndex],
    };
    const properties: LegacyDescriptorAggregate['descriptors'][number][] = [];
    for (const [id, camel, snake] of [
      ['grid-style', 'gridStyle', 'grid_style'],
      ['row-style', 'rowStyle', 'row_style'],
    ] as const) {
      const value = rawView[camel] ?? rawView[snake];
      if (value !== undefined) {
        properties.push(member(
          'view-property',
          id,
          { key: camel, value: clone(value) },
          parent,
        ));
      }
    }
    return [
      member('view', viewId, base),
      ...filters.map((filter, index) => member(
        'view-filter',
        idOf(filter, `filter-${index}`),
        { ...without(filter, ['order']), order: filterOrders[index] },
        parent,
      )),
      ...rules.map((rule, index) => member(
        'view-projection-rule',
        idOf(rule, `rule-${index}`),
        { ...without(rule, ['order']), order: ruleOrders[index] },
        parent,
      )),
      ...splitColumns(rawView.columns, viewId),
      ...properties,
      ...Object.entries(positions).map(([recordKey, position], index) => member(
        'view-canvas-position',
        recordKey,
        {
          recordKey,
          ...(isRecord(position) ? clone(position) : {}),
          order: positionOrders[index],
        },
        parent,
      )),
    ];
  });
  const paletteOrders = spreadKeys(palette.length);
  return [
    ...descriptors,
    ...palette.flatMap((value, index) => {
      const raw = typeof value === 'string' ? { color: value } : value;
      if (!isRecord(raw)) return [];
      return [member(
        'palette-color',
        idOf(raw, `color-${index}`),
        { ...without(raw, ['order']), order: paletteOrders[index] },
      )];
    }),
  ];
}

function splitGridProperties(payload: unknown): LegacyDescriptorAggregate['descriptors'] {
  const values = Array.isArray(payload)
    ? payload.filter(isRecord)
    : isRecord(payload) && Array.isArray(payload.descriptors)
      ? payload.descriptors.filter(isRecord)
      : [];
  const orders = spreadKeys(values.length);
  return values.map((value, index) => member(
    'grid-property',
    idOf(value, `property-${index}`),
    { ...without(value, ['order']), order: orders[index] },
  ));
}

export function splitLegacyVisualDatabaseAggregate(input: {
  kind: VisualDatabaseLegacyAggregateKind;
  addressLabel: string;
  payloadHash: Uint8Array;
  payload: unknown;
}): LegacyDescriptorAggregate {
  const descriptors = input.kind === 'fields'
    ? splitFields(input.payload)
    : input.kind === 'views'
      ? splitViews(input.payload)
      : splitGridProperties(input.payload);
  return {
    addressLabel: input.addressLabel,
    payloadHash: new Uint8Array(input.payloadHash),
    descriptors,
  };
}
