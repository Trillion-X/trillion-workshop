// package://packages/person-list/read-data/read-people.ts
//
// Generic addressed-record reader for list-like surfaces. Domain labels and
// source-key aliases arrive as descriptors; this file only merges records,
// relationship/profile field maps, and search text.

export interface RecordFieldDescriptor {
  key: string;
  label?: string;
  sourceKeys?: readonly string[];
  searchable?: boolean;
  displayRole?: 'title' | 'subtitle' | 'detail' | 'metric' | 'chip';
  order?: number;
}

export interface AddressedRecord {
  id: string;
  fields: Record<string, string>;
}

export interface JoinedAddressedRecord extends AddressedRecord {
  title: string;
  subtitle: string;
  detail: string;
}

export function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

export function firstText(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const text = textValue(row[key]);
    if (text.length > 0) return text;
  }
  return '';
}

function rows(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is Record<string, unknown> => (
    !!row && typeof row === 'object' && !Array.isArray(row)
  ));
}

function recordId(row: Record<string, unknown>): string {
  return textValue(row.id) || textValue(row.record_ref) || textValue(row.actor_ref);
}

function humanizeRef(ref: string): string {
  const tail = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
  const words = tail.replace(/[-_]+/g, ' ').trim();
  return words.length > 0
    ? words.replace(/\b\w/g, (letter) => letter.toUpperCase())
    : ref;
}

function parseRequestJson(raw: unknown): Record<string, unknown> | null {
  const text = textValue(raw);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function orderedDescriptors(
  descriptors: readonly RecordFieldDescriptor[],
): RecordFieldDescriptor[] {
  return [...descriptors]
    .filter((descriptor) => textValue(descriptor.key).length > 0)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));
}

function displayValue(
  record: AddressedRecord,
  descriptors: readonly RecordFieldDescriptor[],
  role: RecordFieldDescriptor['displayRole'],
): string {
  const descriptor = orderedDescriptors(descriptors).find((item) => item.displayRole === role);
  return descriptor ? textValue(record.fields[descriptor.key]) : '';
}

export function decodeRecordFieldDescriptors(raw: unknown): RecordFieldDescriptor[] {
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { fields?: unknown[] }).fields)
      ? (raw as { fields: unknown[] }).fields
      : [];
  return source
    .filter((item): item is Record<string, unknown> => (
      !!item && typeof item === 'object' && !Array.isArray(item)
    ))
    .map((item) => ({
      key: textValue(item.key),
      label: textValue(item.label) || undefined,
      sourceKeys: Array.isArray(item.source_keys)
        ? item.source_keys.map(textValue).filter(Boolean)
        : Array.isArray(item.sourceKeys)
          ? item.sourceKeys.map(textValue).filter(Boolean)
          : undefined,
      searchable: typeof item.searchable === 'boolean' ? item.searchable : undefined,
      displayRole: (
        item.display_role === 'title'
        || item.display_role === 'subtitle'
        || item.display_role === 'detail'
        || item.display_role === 'metric'
        || item.display_role === 'chip'
      ) ? item.display_role : undefined,
      order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : undefined,
    }))
    .filter((item) => item.key.length > 0);
}

export function decodeFieldValueRows(raw: unknown): Map<string, Record<string, string>> {
  const byRecord = new Map<string, Record<string, string>>();
  for (const row of rows(raw)) {
    const id = recordId(row);
    if (!id) continue;
    const request = parseRequestJson(row.request_json);
    if (!request) continue;
    const key = textValue(request.field) || textValue(request.key);
    const value = textValue(request.value);
    if (!key || !value) continue;
    byRecord.set(id, { ...(byRecord.get(id) ?? {}), [key]: value });
  }
  return byRecord;
}

export function decodeAddressedRecords(
  raw: unknown,
  descriptors: readonly RecordFieldDescriptor[] = [],
): AddressedRecord[] {
  const fields = orderedDescriptors(descriptors);
  return rows(raw)
    .map((row) => {
      const id = recordId(row);
      const values: Record<string, string> = {};
      for (const descriptor of fields) {
        const keys = descriptor.sourceKeys && descriptor.sourceKeys.length > 0
          ? descriptor.sourceKeys
          : [descriptor.key];
        const value = firstText(row, keys);
        if (value) values[descriptor.key] = value;
      }
      return { id, fields: values };
    })
    .filter((record) => record.id.length > 0);
}

export function joinFieldValuesToRecords(
  records: readonly AddressedRecord[],
  fieldValues: ReadonlyMap<string, Record<string, string>>,
  descriptors: readonly RecordFieldDescriptor[] = [],
): { records: JoinedAddressedRecord[]; withFieldValues: number } {
  let withFieldValues = 0;
  const joined = records.map((record) => {
    const extra = fieldValues.get(record.id);
    const fields = extra ? { ...record.fields, ...extra } : { ...record.fields };
    if (extra) withFieldValues += 1;
    const merged = { id: record.id, fields };
    const title = displayValue(merged, descriptors, 'title') || humanizeRef(record.id);
    return {
      ...merged,
      title,
      subtitle: displayValue(merged, descriptors, 'subtitle'),
      detail: displayValue(merged, descriptors, 'detail'),
    };
  });
  return { records: joined, withFieldValues };
}

export function mergeAddressedRecords(
  ...feeds: readonly AddressedRecord[][]
): AddressedRecord[] {
  const byId = new Map<string, AddressedRecord>();
  for (const feed of feeds) {
    for (const record of feed) {
      if (!byId.has(record.id)) byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function filterAddressedRecords(
  records: readonly JoinedAddressedRecord[],
  search: string,
  descriptors: readonly RecordFieldDescriptor[] = [],
): JoinedAddressedRecord[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return [...records];
  const searchableKeys = orderedDescriptors(descriptors)
    .filter((descriptor) => descriptor.searchable !== false)
    .map((descriptor) => descriptor.key);
  return records.filter((record) => {
    const values = searchableKeys.length > 0
      ? searchableKeys.map((key) => record.fields[key])
      : Object.values(record.fields);
    return [record.title, record.subtitle, record.detail, ...values]
      .some((value) => textValue(value).toLowerCase().includes(needle));
  });
}

export function recordInitial(label: string): string {
  const first = label.trim().charAt(0);
  return first ? first.toUpperCase() : '?';
}
