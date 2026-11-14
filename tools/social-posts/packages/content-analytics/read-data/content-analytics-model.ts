// package-set://bitfield-studio/packages/content-analytics/read-data/content-analytics-model.ts
//
// Pure descriptor-driven projection for the content-analytics surface. Domain
// words live in package data; this module only follows record, field, view,
// rule, and action descriptors.

import { readPostPerformanceAttributionRows } from './post-performance-attribution';

export type JsonRecord = Record<string, unknown>;

export interface ContentAnalyticsEvidenceRow {
  address?: string;
  role?: string;
  payload?: unknown;
  blocker?: ContentAnalyticsBlocker;
}

export interface ContentAnalyticsBlocker {
  code?: string;
  message?: string;
  severity?: string;
}

export interface ContentAnalyticsFieldDescriptor {
  id: string;
  label: string;
  role?: string;
  paths: readonly (readonly string[])[];
  format?: {
    kind?: string;
    empty?: string;
    maximumFractionDigits?: number;
    minimumFractionDigits?: number;
  };
}

export interface ContentAnalyticsViewDescriptor {
  id: string;
  label: string;
  eyebrow?: string;
  status?: {
    empty?: string;
    waiting?: string;
    ready?: string;
    blocked?: string;
  };
  primary?: {
    valueField: string;
    labelField?: string;
    detailField?: string;
    emptyValue?: string;
    emptyLabel?: string;
  };
  item?: {
    sourceRole: string;
    titleField?: string;
    detailFields?: readonly string[];
    badgeField?: string;
    maxItems?: number;
  };
  detail?: {
    fields?: readonly string[];
  };
}

export interface ContentAnalyticsActionDescriptor {
  id: string;
  label: string;
  target?: string;
  operation?: string;
  definitionId?: string;
  input?: JsonRecord;
  copy?: readonly ContentAnalyticsActionInputCopy[];
}

export interface ContentAnalyticsActionInputCopy {
  key: string;
  from?: string;
  value?: unknown;
}

export interface ContentAnalyticsRuleDescriptor {
  id: string;
  message: string;
  severity?: string;
  when?: {
    missingRole?: string;
    blockerSeverity?: string;
  };
}

export interface ContentAnalyticsDescriptorSet {
  fields?: readonly ContentAnalyticsFieldDescriptor[];
  views?: readonly ContentAnalyticsViewDescriptor[];
  actions?: readonly ContentAnalyticsActionDescriptor[];
  rules?: readonly ContentAnalyticsRuleDescriptor[];
}

export interface ReadContentAnalyticsModelInput {
  rows?: unknown;
  descriptors?: ContentAnalyticsDescriptorSet;
}

export interface ContentAnalyticsValue {
  fieldId: string;
  label: string;
  value: unknown;
  text: string;
}

export interface ContentAnalyticsModelItem {
  id: string;
  title: string;
  detail: string;
  badge?: string;
  values: readonly ContentAnalyticsValue[];
  raw: unknown;
}

export interface ContentAnalyticsModelAction {
  id: string;
  label: string;
  target: string;
  operation: string;
  definitionId?: string;
  input?: JsonRecord;
  copy: readonly ContentAnalyticsActionInputCopy[];
  blocked: boolean;
  blockedReason?: string;
}

export interface ContentAnalyticsModel {
  status: string;
  statusTone: 'muted' | 'info' | 'success' | 'warning';
  eyebrow: string;
  title: string;
  primary: {
    value: string;
    label: string;
    detail?: string;
  };
  itemsTitle: string;
  items: readonly ContentAnalyticsModelItem[];
  empty: {
    title: string;
    detail: string;
  };
  detailsTitle: string;
  details: readonly ContentAnalyticsValue[];
  blockers: readonly ContentAnalyticsBlocker[];
  actions: readonly ContentAnalyticsModelAction[];
  revision: string;
  proof: {
    descriptorCount: number;
    sourceRecordCount: number;
  };
}

const DESCRIPTOR_KINDS = new Set([
  'content-analytics.record-view',
  'content-analytics.field-descriptors',
  'content-analytics.action-descriptors',
  'content-analytics.rule-descriptors',
]);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function evidenceRows(raw: unknown): ContentAnalyticsEvidenceRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is ContentAnalyticsEvidenceRow => isRecord(row));
}

function payloadsByRole(rows: readonly ContentAnalyticsEvidenceRow[]): Record<string, JsonRecord[]> {
  const byRole: Record<string, JsonRecord[]> = {};
  for (const row of rows) {
    if (typeof row.role !== 'string' || !isRecord(row.payload)) continue;
    byRole[row.role] = [...(byRole[row.role] ?? []), row.payload];
  }
  return byRole;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function readField(record: unknown, field?: ContentAnalyticsFieldDescriptor): unknown {
  if (!field) return undefined;
  for (const path of field.paths) {
    const value = readPath(record, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function formatValue(value: unknown, field?: ContentAnalyticsFieldDescriptor): string {
  if (value === undefined || value === null || value === '') return field?.format?.empty ?? '';
  if (field?.format?.kind === 'datetime' && typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (field?.format?.kind === 'number' && typeof value === 'number') {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: field.format.maximumFractionDigits ?? 2,
      minimumFractionDigits: field.format.minimumFractionDigits,
    }).format(value);
  }
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).filter(Boolean).join(', ');
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

function fieldById(fields: readonly ContentAnalyticsFieldDescriptor[], id?: string): ContentAnalyticsFieldDescriptor | undefined {
  return id ? fields.find((field) => field.id === id) : undefined;
}

function valueFor(record: unknown, field: ContentAnalyticsFieldDescriptor): ContentAnalyticsValue {
  const value = readField(record, field);
  return {
    fieldId: field.id,
    label: field.label,
    value,
    text: formatValue(value, field),
  };
}

function descriptorPayloads(rows: readonly ContentAnalyticsEvidenceRow[]): ContentAnalyticsDescriptorSet {
  const descriptors: ContentAnalyticsDescriptorSet = {};
  for (const row of rows) {
    if (!isRecord(row.payload) || typeof row.payload.kind !== 'string' || !DESCRIPTOR_KINDS.has(row.payload.kind)) continue;
    if (Array.isArray(row.payload.descriptors)) descriptors.fields = row.payload.descriptors as ContentAnalyticsFieldDescriptor[];
    if (Array.isArray(row.payload.views)) descriptors.views = row.payload.views as ContentAnalyticsViewDescriptor[];
    if (Array.isArray(row.payload.actions)) descriptors.actions = row.payload.actions as ContentAnalyticsActionDescriptor[];
    if (Array.isArray(row.payload.rules)) descriptors.rules = row.payload.rules as ContentAnalyticsRuleDescriptor[];
  }
  return descriptors;
}

function mergeDescriptors(
  supplied: ContentAnalyticsDescriptorSet | undefined,
  fromRows: ContentAnalyticsDescriptorSet,
): Required<ContentAnalyticsDescriptorSet> {
  return {
    fields: supplied?.fields ?? fromRows.fields ?? [],
    views: supplied?.views ?? fromRows.views ?? [],
    actions: supplied?.actions ?? fromRows.actions ?? [],
    rules: supplied?.rules ?? fromRows.rules ?? [],
  };
}

function evaluatedBlockers(
  rows: readonly ContentAnalyticsEvidenceRow[],
  byRole: Record<string, JsonRecord[]>,
  rules: readonly ContentAnalyticsRuleDescriptor[],
): ContentAnalyticsBlocker[] {
  const blockers = rows.flatMap((row) => row.blocker ? [row.blocker] : []);
  for (const rule of rules) {
    if (rule.when?.missingRole && (byRole[rule.when.missingRole]?.length ?? 0) === 0) {
      blockers.push({ code: rule.id, message: rule.message, severity: rule.severity });
    }
    if (rule.when?.blockerSeverity && blockers.some((blocker) => blocker.severity === rule.when?.blockerSeverity)) {
      blockers.push({ code: rule.id, message: rule.message, severity: rule.severity });
    }
  }
  return blockers;
}

function itemId(record: unknown, index: number): string {
  if (isRecord(record)) {
    for (const key of ['id', 'record_id', 'address']) {
      const value = record[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return `item:${index}`;
}

function modelItems(
  rows: readonly JsonRecord[],
  fields: readonly ContentAnalyticsFieldDescriptor[],
  view: ContentAnalyticsViewDescriptor,
): ContentAnalyticsModelItem[] {
  const titleField = fieldById(fields, view.item?.titleField);
  const badgeField = fieldById(fields, view.item?.badgeField);
  const detailFields = (view.item?.detailFields ?? [])
    .map((id) => fieldById(fields, id))
    .filter((field): field is ContentAnalyticsFieldDescriptor => Boolean(field));
  const valueFields = fields.filter((field) => field.role === 'value' || field.role === 'detail');
  return rows.slice(0, view.item?.maxItems).map((record, index) => {
    const title = formatValue(readField(record, titleField), titleField) || `Result ${index + 1}`;
    const details = detailFields.map((field) => valueFor(record, field).text).filter(Boolean);
    const badge = formatValue(readField(record, badgeField), badgeField) || undefined;
    return {
      id: itemId(record, index),
      title,
      detail: details.join(' / '),
      badge,
      values: valueFields.map((field) => valueFor(record, field)).filter((value) => value.text),
      raw: record,
    };
  });
}

export function readContentAnalyticsModel(input: ReadContentAnalyticsModelInput): ContentAnalyticsModel {
  const sourceRows = evidenceRows(input.rows);
  const rows = [...sourceRows, ...readPostPerformanceAttributionRows(sourceRows)];
  const rowDescriptors = descriptorPayloads(rows);
  const descriptors = mergeDescriptors(input.descriptors, rowDescriptors);
  const byRole = payloadsByRole(rows);
  const view = descriptors.views[0] ?? { id: 'default', label: 'Content results', item: { sourceRole: 'results' } };
  const itemSourceRole = view.item?.sourceRole ?? 'results';
  const sourceRecords = byRole[itemSourceRole] ?? [];
  const blockers = evaluatedBlockers(rows, byRole, descriptors.rules);
  const items = modelItems(sourceRecords, descriptors.fields, view);
  const hasBlockers = blockers.length > 0;
  const hasItems = items.length > 0;
  const hasAnyRows = rows.length > 0;
  const primaryRecord = items[0]?.raw;
  const primaryValueField = fieldById(descriptors.fields, view.primary?.valueField);
  const primaryLabelField = fieldById(descriptors.fields, view.primary?.labelField);
  const primaryDetailField = fieldById(descriptors.fields, view.primary?.detailField);
  const primaryValue = formatValue(readField(primaryRecord, primaryValueField), primaryValueField);
  const primaryLabel = formatValue(readField(primaryRecord, primaryLabelField), primaryLabelField);
  const detailFields = (view.detail?.fields ?? [])
    .map((id) => fieldById(descriptors.fields, id))
    .filter((field): field is ContentAnalyticsFieldDescriptor => Boolean(field));
  const blocked = hasBlockers;

  return {
    status: hasBlockers
      ? view.status?.blocked ?? 'Needs attention'
      : hasItems
        ? view.status?.ready ?? 'Ready'
        : hasAnyRows
          ? view.status?.waiting ?? 'Waiting'
          : view.status?.empty ?? 'Empty',
    statusTone: hasBlockers ? 'warning' : hasItems ? 'success' : hasAnyRows ? 'info' : 'muted',
    eyebrow: view.eyebrow ?? 'Results',
    title: view.label,
    primary: {
      value: primaryValue || view.primary?.emptyValue || (hasItems ? String(items.length) : 'Waiting'),
      label: primaryLabel || view.primary?.emptyLabel || (hasItems ? 'Ready to review.' : 'Results appear after a finished post reports back.'),
      detail: formatValue(readField(primaryRecord, primaryDetailField), primaryDetailField) || undefined,
    },
    itemsTitle: view.item ? view.label : 'Results',
    items,
    empty: {
      title: 'Results are waiting',
      detail: 'Connect a finished post or result source and the latest results will appear here.',
    },
    detailsTitle: 'More',
    details: primaryRecord
      ? detailFields.map((field) => valueFor(primaryRecord, field)).filter((value) => value.text)
      : [],
    blockers,
    actions: descriptors.actions.map((action) => ({
      id: action.id,
      label: action.label,
      target: action.target ?? 'slot::workflow',
      operation: action.operation ?? 'execute_definition',
      definitionId: action.definitionId,
      input: action.input,
      copy: action.copy ?? [],
      blocked,
      blockedReason: blocked ? blockers[0]?.message ?? 'This action is blocked.' : undefined,
    })),
    revision: `${rows.length}:${descriptors.fields.length}:${descriptors.actions.length}:${blockers.length}`,
    proof: {
      descriptorCount: descriptors.fields.length + descriptors.views.length + descriptors.actions.length + descriptors.rules.length,
      sourceRecordCount: sourceRecords.length,
    },
  };
}
