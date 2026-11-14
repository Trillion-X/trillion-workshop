import {
  isObject,
  objectList,
  text,
  textList,
} from './universal-action-event-contract.ts';
import type {
  JsonObject,
  UniversalActionEventActionDescriptor,
  UniversalActionEventDescriptorSet,
  UniversalActionEventFieldDescriptor,
  UniversalActionEventInputMapping,
  UniversalActionEventProcessProofDescriptor,
  UniversalActionEventProofDescriptor,
  UniversalActionEventRecord,
  UniversalActionEventViewDescriptor,
} from './universal-action-event-contract.ts';

function pathList(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.filter(Array.isArray).map((path) => path.filter((part): part is string => typeof part === 'string'));
}

function decodeInputMapping(raw: unknown): UniversalActionEventInputMapping | null {
  if (!isObject(raw)) return null;
  const key = text(raw.key);
  if (!key) return null;
  const from = textList(raw.from);
  return {
    key,
    ...(from.length > 0 ? { from } : {}),
    ...(Object.prototype.hasOwnProperty.call(raw, 'value') ? { value: raw.value } : {}),
  };
}

function decodeField(raw: unknown): UniversalActionEventFieldDescriptor | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  const label = text(raw.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    ...(text(raw.role) ? { role: text(raw.role) } : {}),
    ...(pathList(raw.paths).length > 0 ? { paths: pathList(raw.paths) } : {}),
    ...(isObject(raw.display) ? { display: raw.display as UniversalActionEventFieldDescriptor['display'] } : {}),
  };
}

function decodeProof(raw: unknown): UniversalActionEventProofDescriptor | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  if (!id) return null;
  const disclosure = text(raw.disclosure);
  return {
    id,
    ...(text(raw.label) ? { label: text(raw.label) } : {}),
    ...(text(raw.sourceRef ?? raw.source_ref) ? { sourceRef: text(raw.sourceRef ?? raw.source_ref) } : {}),
    ...(pathList(raw.paths).length > 0 ? { paths: pathList(raw.paths) } : {}),
    ...(disclosure === 'summary' || disclosure === 'support' || disclosure === 'hidden' ? { disclosure } : {}),
    ...(text(raw.errorText ?? raw.error_text) ? { errorText: text(raw.errorText ?? raw.error_text) } : {}),
    ...(typeof raw.order === 'number' ? { order: raw.order } : {}),
  };
}

function decodeProcessProof(raw: unknown): UniversalActionEventProcessProofDescriptor | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  if (!id) return null;
  return {
    id,
    ...(text(raw.label) ? { label: text(raw.label) } : {}),
    ...(textList(raw.sessionRefPath ?? raw.session_ref_path).length > 0 ? { sessionRefPath: textList(raw.sessionRefPath ?? raw.session_ref_path) } : {}),
    ...(textList(raw.eventFeedRefPath ?? raw.event_feed_ref_path).length > 0 ? { eventFeedRefPath: textList(raw.eventFeedRefPath ?? raw.event_feed_ref_path) } : {}),
    ...(pathList(raw.summaryPaths ?? raw.summary_paths).length > 0 ? { summaryPaths: pathList(raw.summaryPaths ?? raw.summary_paths) } : {}),
    ...(text(raw.proofDescriptorId ?? raw.proof_descriptor_id) ? { proofDescriptorId: text(raw.proofDescriptorId ?? raw.proof_descriptor_id) } : {}),
  };
}

function decodeAction(raw: unknown): UniversalActionEventActionDescriptor | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  const label = text(raw.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    ...(text(raw.target) ? { target: text(raw.target) } : {}),
    ...(text(raw.operation) ? { operation: text(raw.operation) } : {}),
    ...(text(raw.definitionId ?? raw.definition_id) ? { definitionId: text(raw.definitionId ?? raw.definition_id) } : {}),
    ...(isObject(raw.input) ? { input: raw.input } : {}),
    ...(objectList(raw.inputMapping ?? raw.input_mapping).length > 0
      ? { inputMapping: objectList(raw.inputMapping ?? raw.input_mapping).map(decodeInputMapping).filter((entry): entry is UniversalActionEventInputMapping => entry !== null) }
      : {}),
    ...(isObject(raw.availability) ? { availability: raw.availability as UniversalActionEventActionDescriptor['availability'] } : {}),
    ...(text(raw.offlinePolicy ?? raw.offline_policy) ? { offlinePolicy: text(raw.offlinePolicy ?? raw.offline_policy) } : {}),
  };
}

function decodeView(raw: unknown): UniversalActionEventViewDescriptor | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  const label = text(raw.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    rowFields: textList(raw.rowFields ?? raw.row_fields),
    detailFields: textList(raw.detailFields ?? raw.detail_fields),
    proofDescriptors: textList(raw.proofDescriptors ?? raw.proof_descriptors),
    actions: textList(raw.actions),
    ...(text(raw.groupByRole ?? raw.group_by_role) ? { groupByRole: text(raw.groupByRole ?? raw.group_by_role) } : {}),
    ...(Array.isArray(raw.sort) ? { sort: raw.sort.filter(isObject).map((entry) => ({ field: text(entry.field), direction: text(entry.direction) === 'desc' ? 'desc' : 'asc' })) } : {}),
    ...(isObject(raw.copy) ? { copy: raw.copy as UniversalActionEventViewDescriptor['copy'] } : {}),
  };
}

function decodeDomainOption(raw: unknown) {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  const label = text(raw.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    ...(text(raw.role) ? { role: text(raw.role) } : {}),
    ...(text(raw.group) ? { group: text(raw.group) } : {}),
    ...(text(raw.tone) ? { tone: text(raw.tone) } : {}),
    order: typeof raw.order === 'number' ? raw.order : 500,
    ...(isObject(raw.copy) ? { copy: raw.copy } : {}),
  };
}

function decodeRelationship(raw: unknown) {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  if (!id) return null;
  return {
    id,
    ...(text(raw.fromRole ?? raw.from_role) ? { fromRole: text(raw.fromRole ?? raw.from_role) } : {}),
    ...(text(raw.toRole ?? raw.to_role) ? { toRole: text(raw.toRole ?? raw.to_role) } : {}),
    ...(text(raw.label) ? { label: text(raw.label) } : {}),
    ...(text(raw.cardinality) ? { cardinality: text(raw.cardinality) } : {}),
  };
}

function decodeRule(raw: unknown) {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  const message = text(raw.message);
  if (!id || !message) return null;
  return {
    id,
    message,
    ...(text(raw.severity) ? { severity: text(raw.severity) } : {}),
    ...(isObject(raw.when) ? { when: raw.when } : {}),
  };
}

function requireDecoded<T>(rawRows: readonly JsonObject[], kind: string, decode: (raw: unknown) => T | null): T[] {
  return rawRows.map((row, index) => {
    const decoded = decode(row);
    if (!decoded) throw new Error(`${kind} descriptor at index ${index} is malformed`);
    return decoded;
  });
}

export function decodeUniversalActionEventRecords(raw: unknown): UniversalActionEventRecord[] {
  return objectList(raw).map((row) => ({
    recordId: text(row.recordId ?? row.record_id ?? row.id),
    subjectRefs: textList(row.subjectRefs ?? row.subject_refs),
    actorRefs: textList(row.actorRefs ?? row.actor_refs),
    sourceRefs: textList(row.sourceRefs ?? row.source_refs),
    ...(text(row.actionRef ?? row.action_ref) ? { actionRef: text(row.actionRef ?? row.action_ref) } : {}),
    fieldValues: isObject(row.fieldValues ?? row.field_values) ? (row.fieldValues ?? row.field_values) as JsonObject : {},
    domainOptionRefs: textList(row.domainOptionRefs ?? row.domain_option_refs),
    relationshipRefs: textList(row.relationshipRefs ?? row.relationship_refs),
    ruleEvalRefs: textList(row.ruleEvalRefs ?? row.rule_eval_refs),
    proofRefs: textList(row.proofRefs ?? row.proof_refs),
    processSessionRefs: textList(row.processSessionRefs ?? row.process_session_refs),
    ownerActionRefs: textList(row.ownerActionRefs ?? row.owner_action_refs),
    ...(text(row.occurredAt ?? row.occurred_at) ? { occurredAt: text(row.occurredAt ?? row.occurred_at) } : {}),
    ...(text(row.idempotenceKey ?? row.idempotence_key) ? { idempotenceKey: text(row.idempotenceKey ?? row.idempotence_key) } : {}),
    ...(isObject(row.payload) ? { payload: row.payload } : {}),
  })).filter((row) => row.recordId);
}

export function decodeUniversalActionEventDescriptors(raw: unknown): UniversalActionEventDescriptorSet {
  const source = isObject(raw) ? raw : {};
  const disabledReasonsRaw = source.disabledReasons ?? source.disabled_reasons;
  return {
    fields: requireDecoded(objectList(source.fields), 'field', decodeField),
    domainOptions: requireDecoded(objectList(source.domainOptions ?? source.domain_options), 'domain option', decodeDomainOption),
    relationships: requireDecoded(objectList(source.relationships), 'relationship', decodeRelationship),
    proofs: requireDecoded(objectList(source.proofs), 'proof', decodeProof),
    processProofs: requireDecoded(objectList(source.processProofs ?? source.process_proofs), 'process proof', decodeProcessProof),
    actions: requireDecoded(objectList(source.actions), 'action', decodeAction),
    views: requireDecoded(objectList(source.views), 'view', decodeView),
    rules: requireDecoded(objectList(source.rules), 'rule', decodeRule),
    disabledReasons: isObject(disabledReasonsRaw)
      ? disabledReasonsRaw as Record<string, string>
      : {},
  };
}
