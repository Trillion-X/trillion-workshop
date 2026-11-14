import { text, readPath } from './universal-action-event-contract.ts';
import type {
  JsonObject,
  UniversalActionEventActionDescriptor,
  UniversalActionEventDescriptorSet,
  UniversalActionEventFieldDescriptor,
  UniversalActionEventModel,
  UniversalActionEventModelAction,
  UniversalActionEventModelOption,
  UniversalActionEventModelProof,
  UniversalActionEventModelRow,
  UniversalActionEventProofDescriptor,
  UniversalActionEventRecord,
  UniversalActionEventViewDescriptor,
} from './universal-action-event-contract.ts';

function byId<T extends { id: string }>(rows: readonly T[] = []): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function formatValue(value: unknown, field?: UniversalActionEventFieldDescriptor): string {
  if (value === undefined || value === null || value === '') return field?.display?.emptyText ?? '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function readField(record: UniversalActionEventRecord, field: UniversalActionEventFieldDescriptor): unknown {
  for (const path of field.paths ?? []) {
    const value = readPath(record.fieldValues, path) ?? readPath(record.payload, path) ?? readPath(record, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return record.fieldValues?.[field.id] ?? record.payload?.[field.id];
}

function optionModels(record: UniversalActionEventRecord, descriptors: UniversalActionEventDescriptorSet): UniversalActionEventModelOption[] {
  const options = byId(descriptors.domainOptions);
  return (record.domainOptionRefs ?? []).map((id) => options.get(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).map((entry) => ({
    id: entry.id,
    label: entry.label,
    role: entry.role,
    group: entry.group,
    tone: entry.tone,
    order: entry.order ?? 500,
  })).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function proofText(record: UniversalActionEventRecord, proof: UniversalActionEventProofDescriptor): string {
  for (const path of proof.paths ?? []) {
    const value = readPath(record.fieldValues, path) ?? readPath(record.payload, path);
    const rendered = formatValue(value);
    if (rendered) return rendered;
  }
  return proof.errorText ?? '';
}

function proofModels(record: UniversalActionEventRecord, view: UniversalActionEventViewDescriptor, descriptors: UniversalActionEventDescriptorSet): UniversalActionEventModelProof[] {
  const proofs = byId(descriptors.proofs);
  return (view.proofDescriptors ?? record.proofRefs ?? []).map((id) => proofs.get(id)).filter((entry): entry is UniversalActionEventProofDescriptor => Boolean(entry)).map((proof) => ({
    id: proof.id,
    label: proof.label ?? proof.id,
    text: proofText(record, proof),
    disclosure: proof.disclosure ?? 'summary',
    sourceRef: proof.sourceRef,
    ...(proofText(record, proof) ? {} : { error: proof.errorText ?? 'Proof is not available.' }),
  })).filter((proof) => proof.disclosure !== 'hidden').sort((a, b) => (proofs.get(a.id)?.order ?? 500) - (proofs.get(b.id)?.order ?? 500) || a.id.localeCompare(b.id));
}

function actionModels(record: UniversalActionEventRecord, view: UniversalActionEventViewDescriptor, descriptors: UniversalActionEventDescriptorSet): UniversalActionEventModelAction[] {
  const actions = byId(descriptors.actions);
  const reasonText = descriptors.disabledReasons ?? {};
  return (view.actions ?? record.ownerActionRefs ?? []).map((id) => actions.get(id)).filter((entry): entry is UniversalActionEventActionDescriptor => Boolean(entry)).map((action) => {
    const missingRoute = Boolean(action.availability?.requiresRoute) && !action.definitionId && !action.target;
    const readOnly = action.offlinePolicy === 'read-only';
    const reasonId = missingRoute ? action.availability?.disabledReasonId : readOnly ? action.availability?.readOnlyReasonId : undefined;
    return {
      id: action.id,
      label: action.label,
      target: action.target,
      operation: action.operation ?? 'execute_definition',
      definitionId: action.definitionId,
      disabled: missingRoute || readOnly,
      ...(reasonId && reasonText[reasonId] ? { disabledReason: reasonText[reasonId] } : {}),
    };
  });
}

function valuesFor(record: UniversalActionEventRecord, view: UniversalActionEventViewDescriptor, descriptors: UniversalActionEventDescriptorSet): UniversalActionEventModelRow['values'] {
  const fields = byId(descriptors.fields);
  const selected = (view.rowFields && view.rowFields.length > 0 ? view.rowFields : descriptors.fields?.map((field) => field.id) ?? [])
    .map((id) => fields.get(id))
    .filter((entry): entry is UniversalActionEventFieldDescriptor => Boolean(entry));
  return selected.map((field) => {
    const value = readField(record, field);
    return {
      fieldId: field.id,
      label: field.label,
      value,
      text: formatValue(value, field),
    };
  });
}

function compareRows(view: UniversalActionEventViewDescriptor) {
  return (a: UniversalActionEventModelRow, b: UniversalActionEventModelRow): number => {
    for (const sort of view.sort ?? []) {
      const av = a.values.find((value) => value.fieldId === sort.field)?.text ?? '';
      const bv = b.values.find((value) => value.fieldId === sort.field)?.text ?? '';
      const result = av.localeCompare(bv);
      if (result !== 0) return sort.direction === 'desc' ? -result : result;
    }
    return b.sortKey.localeCompare(a.sortKey) || a.id.localeCompare(b.id);
  };
}

function firstView(descriptors: UniversalActionEventDescriptorSet, viewId?: string): UniversalActionEventViewDescriptor {
  const found = descriptors.views?.find((view) => view.id === viewId) ?? descriptors.views?.[0];
  return found ?? { id: 'default', label: 'Action events' };
}

export function projectUniversalActionEvents(input: {
  records: readonly UniversalActionEventRecord[];
  descriptors: UniversalActionEventDescriptorSet;
  viewId?: string;
  selectedId?: string | null;
  freshness?: { value?: string };
}): UniversalActionEventModel {
  const view = firstView(input.descriptors, input.viewId);
  const rows = input.records.map((record) => ({
    id: record.recordId,
    occurredAt: record.occurredAt,
    sortKey: record.occurredAt ?? record.idempotenceKey ?? record.recordId,
    values: valuesFor(record, view, input.descriptors),
    options: optionModels(record, input.descriptors),
    proofs: proofModels(record, view, input.descriptors),
    actions: actionModels(record, view, input.descriptors),
    refs: {
      subjects: record.subjectRefs ?? [],
      actors: record.actorRefs ?? [],
      sources: record.sourceRefs ?? [],
      processSessions: record.processSessionRefs ?? [],
    },
  })).sort(compareRows(view));

  const selected = rows.find((row) => row.id === input.selectedId) ?? rows[0] ?? null;
  const groupsById = new Map<string, UniversalActionEventModelRow[]>();
  for (const row of rows) {
    const option = view.groupByRole ? row.options.find((entry) => entry.role === view.groupByRole) : undefined;
    const groupId = option?.group ?? option?.id ?? 'all';
    groupsById.set(groupId, [...(groupsById.get(groupId) ?? []), row]);
  }
  const optionLabels = byId(input.descriptors.domainOptions);
  const groups = [...groupsById.entries()].map(([id, groupRows]) => ({
    id,
    label: optionLabels.get(id)?.label ?? id,
    rows: groupRows,
  }));
  return {
    viewId: view.id,
    title: view.label,
    rows,
    groups,
    selected,
    empty: {
      title: view.copy?.emptyTitle ?? '',
      detail: view.copy?.emptyDetail ?? '',
    },
    freshness: {
      label: view.copy?.freshnessLabel ?? '',
      value: text(input.freshness?.value),
    },
    proof: {
      recordCount: input.records.length,
      descriptorCount: Object.values(input.descriptors as JsonObject).reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0),
    },
  };
}
