//
// Caller-ready projection from open independently addressed descriptor facts
// into the existing Visual Database decoder inputs. Persistence stays per-member;
// this fold is read-only and contains no owner/package vocabulary.

import {
  descriptorKeyIdentity,
  type AddressedDescriptorSnapshot,
  type DescriptorKey,
} from './addressed-descriptors';

export interface VisualDatabaseAddressedDescriptorInputs {
  fields: {
    kind: 'visual-database.fields';
    version: 3;
    descriptors: readonly unknown[];
  };
  views: {
    kind: 'visual-database.views';
    version: 3;
    views: readonly unknown[];
    palette: readonly unknown[];
  };
  gridProperties: readonly unknown[];
  retainedUnknown: readonly AddressedDescriptorSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parentOf(key: DescriptorKey, family: string): DescriptorKey | null {
  const parent = [...(key.parent ?? [])].reverse().find((entry) => entry.family === family);
  return parent ?? null;
}

function orderOf(value: unknown, fallback: number): string | number {
  if (isRecord(value) && typeof value.order === 'string' && value.order) return value.order;
  if (isRecord(value) && typeof value.order === 'number' && Number.isFinite(value.order)) {
    return value.order;
  }
  return fallback;
}

function compareOrder(
  left: { snapshot: AddressedDescriptorSnapshot; value: unknown; index: number },
  right: { snapshot: AddressedDescriptorSnapshot; value: unknown; index: number },
): number {
  const leftOrder = orderOf(left.value, left.index);
  const rightOrder = orderOf(right.value, right.index);
  if (typeof leftOrder === 'number' && typeof rightOrder === 'number') {
    const numeric = leftOrder - rightOrder;
    if (numeric !== 0) return numeric;
  } else {
    const leftKey = String(leftOrder);
    const rightKey = String(rightOrder);
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  }
  return descriptorKeyIdentity(left.snapshot.key).localeCompare(
    descriptorKeyIdentity(right.snapshot.key),
  );
}

function snapshotsForFamily(
  snapshots: readonly AddressedDescriptorSnapshot[],
  family: string,
): readonly AddressedDescriptorSnapshot[] {
  return snapshots.filter((snapshot) => snapshot.key.family === family);
}

function childMap(
  snapshots: readonly AddressedDescriptorSnapshot[],
  family: string,
  parentFamily: string,
): ReadonlyMap<string, readonly AddressedDescriptorSnapshot[]> {
  const result = new Map<string, AddressedDescriptorSnapshot[]>();
  for (const snapshot of snapshotsForFamily(snapshots, family)) {
    const parent = parentOf(snapshot.key, parentFamily);
    if (!parent) continue;
    const identity = descriptorKeyIdentity(parent);
    const values = result.get(identity);
    if (values) values.push(snapshot);
    else result.set(identity, [snapshot]);
  }
  return result;
}

function orderedValues(
  snapshots: readonly AddressedDescriptorSnapshot[],
): readonly Record<string, unknown>[] {
  return snapshots
    .map((snapshot, index) => ({ snapshot, index, value: snapshot.payload.value }))
    .filter((entry): entry is typeof entry & { value: Record<string, unknown> } => isRecord(entry.value))
    .sort(compareOrder)
    .map(({ snapshot, value }) => ({
      id: typeof value.id === 'string' && value.id ? value.id : snapshot.key.id,
      ...value,
    }));
}

function projectField(
  snapshot: AddressedDescriptorSnapshot,
  domainValues: ReadonlyMap<string, readonly AddressedDescriptorSnapshot[]>,
): Record<string, unknown> | null {
  if (!isRecord(snapshot.payload.value)) return null;
  const value = { id: snapshot.key.id, ...snapshot.payload.value };
  const children = domainValues.get(descriptorKeyIdentity(snapshot.key)) ?? [];
  if (children.length === 0) return value;
  const existingDomain = isRecord(value.domain) ? value.domain : {};
  return {
    ...value,
    domain: {
      ...existingDomain,
      values: orderedValues(children),
    },
  };
}

function projectView(
  snapshot: AddressedDescriptorSnapshot,
  filters: ReadonlyMap<string, readonly AddressedDescriptorSnapshot[]>,
  rules: ReadonlyMap<string, readonly AddressedDescriptorSnapshot[]>,
  columns: ReadonlyMap<string, readonly AddressedDescriptorSnapshot[]>,
  properties: ReadonlyMap<string, readonly AddressedDescriptorSnapshot[]>,
  positions: ReadonlyMap<string, readonly AddressedDescriptorSnapshot[]>,
): Record<string, unknown> | null {
  if (!isRecord(snapshot.payload.value)) return null;
  const identity = descriptorKeyIdentity(snapshot.key);
  const value: Record<string, unknown> = {
    id: snapshot.key.id,
    ...snapshot.payload.value,
  };
  const filterValues = orderedValues(filters.get(identity) ?? []);
  const ruleValues = orderedValues(rules.get(identity) ?? []);
  if (filterValues.length > 0) value.filters = filterValues;
  if (ruleValues.length > 0) value.projectionRules = ruleValues;

  const columnValues = orderedValues(columns.get(identity) ?? []);
  if (columnValues.length > 0) {
    const order: string[] = [];
    const widths: Record<string, number> = {};
    const styles: Record<string, unknown> = {};
    const hidden: string[] = [];
    for (const column of columnValues) {
      const fieldId = typeof column.fieldId === 'string'
        ? column.fieldId
        : typeof column.field_id === 'string' ? column.field_id : column.id as string;
      order.push(fieldId);
      if (typeof column.width === 'number' && Number.isFinite(column.width)) {
        widths[fieldId] = column.width;
      }
      if (column.hidden === true) hidden.push(fieldId);
      if (isRecord(column.style)) styles[fieldId] = column.style;
    }
    value.columns = {
      order,
      ...(Object.keys(widths).length ? { widths } : {}),
      ...(hidden.length ? { hidden } : {}),
      ...(Object.keys(styles).length ? { styles } : {}),
    };
  }

  for (const property of orderedValues(properties.get(identity) ?? [])) {
    if (typeof property.key === 'string' && Object.prototype.hasOwnProperty.call(property, 'value')) {
      value[property.key] = property.value;
    }
  }

  const canvasPositions: Record<string, { x: number; y: number }> = {};
  for (const position of orderedValues(positions.get(identity) ?? [])) {
    const recordKey = typeof position.recordKey === 'string'
      ? position.recordKey
      : typeof position.record_key === 'string' ? position.record_key : position.id as string;
    if (
      typeof position.x === 'number'
      && Number.isFinite(position.x)
      && typeof position.y === 'number'
      && Number.isFinite(position.y)
    ) canvasPositions[recordKey] = { x: position.x, y: position.y };
  }
  if (Object.keys(canvasPositions).length > 0) value.canvasPositions = canvasPositions;
  return value;
}

export function visualDatabaseInputsFromAddressedDescriptors(
  snapshots: readonly AddressedDescriptorSnapshot[],
): VisualDatabaseAddressedDescriptorInputs {
  const domainValues = childMap(snapshots, 'field-domain-value', 'field');
  const filters = childMap(snapshots, 'view-filter', 'view');
  const rules = childMap(snapshots, 'view-projection-rule', 'view');
  const columns = childMap(snapshots, 'view-column', 'view');
  const properties = childMap(snapshots, 'view-property', 'view');
  const positions = childMap(snapshots, 'view-canvas-position', 'view');
  const fields = snapshotsForFamily(snapshots, 'field')
    .map((snapshot, index) => ({ snapshot, index, value: snapshot.payload.value }))
    .sort(compareOrder)
    .map(({ snapshot }) => projectField(snapshot, domainValues))
    .filter((value): value is Record<string, unknown> => value !== null);
  const views = snapshotsForFamily(snapshots, 'view')
    .map((snapshot, index) => ({ snapshot, index, value: snapshot.payload.value }))
    .sort(compareOrder)
    .map(({ snapshot }) => projectView(
      snapshot,
      filters,
      rules,
      columns,
      properties,
      positions,
    ))
    .filter((value): value is Record<string, unknown> => value !== null);
  const knownFamilies = new Set([
    'view',
    'view-filter',
    'view-projection-rule',
    'view-column',
    'view-property',
    'view-canvas-position',
    'field',
    'field-domain-value',
    'palette-color',
    'grid-property',
  ]);
  return {
    fields: { kind: 'visual-database.fields', version: 3, descriptors: fields },
    views: {
      kind: 'visual-database.views',
      version: 3,
      views,
      palette: orderedValues(snapshotsForFamily(snapshots, 'palette-color')),
    },
    gridProperties: orderedValues(snapshotsForFamily(snapshots, 'grid-property')),
    retainedUnknown: snapshots.filter((snapshot) => !knownFamilies.has(snapshot.key.family)),
  };
}
