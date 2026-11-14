export type RecordMap = Record<string, unknown>;

export interface ExchangeRecord {
  id: string;
  descriptorRef: string;
  title: string;
  values: RecordMap;
}

export interface ExchangeRelationship {
  id: string;
  sourceRef: string;
  relationshipRef: string;
  targetRef: string;
  label: string;
}

export interface ExchangeRule {
  id: string;
  label: string;
  method: string;
  params: RecordMap;
}

export interface ExchangeAction {
  id: string;
  label: string;
  target: string;
  targetOwnerRef: string;
  operationRef: string;
  definitionRef?: string;
  inputBindings: Array<{ from: string; to: string }>;
  ruleRefs: string[];
  resultProjectionRef?: string;
}

export interface ExchangeRecordDescriptor {
  id: string;
  label: string;
  fieldRefs: string[];
  relationshipRefs: string[];
  ruleRefs: string[];
  actionRefs: string[];
  projectionRefs: string[];
}

export interface ExchangeField {
  id: string;
  label: string;
  role: string;
  valuePath: string;
  order: number;
}

export interface ExchangeProjectionDescriptor {
  id: string;
  label: string;
  slotRefs: string[];
  actionRefs: string[];
  proofRelationshipRefs: string[];
  sectionLabels: RecordMap;
  order: number;
}

export interface ExchangeBundleInput {
  descriptors?: RecordMap;
  facts?: RecordMap;
  records?: unknown[];
  relationships?: unknown[];
  proofs?: unknown[];
  processSessions?: unknown[];
}

export interface RuleResult {
  ruleRef: string;
  label: string;
  pass: boolean;
  stateLabel: string;
  stateTone?: string;
  resultRef?: string;
  detail?: string;
}

export interface ProjectedField {
  fieldRef: string;
  label: string;
  role: string;
  value: unknown;
}

export interface ProjectedAction {
  actionRef: string;
  label: string;
  target: string;
  targetOwnerRef: string;
  operationRef: string;
  definitionRef?: string;
  available: boolean;
  reasonRefs: string[];
}

export interface ProjectedRecord {
  recordRef: string;
  descriptorRef: string;
  title: string;
  fields: ProjectedField[];
  relationships: ExchangeRelationship[];
  rules: RuleResult[];
  actions: ProjectedAction[];
  proofs: RecordMap[];
}

export interface RecordExchangeProjection {
  records: ProjectedRecord[];
  descriptors: {
    records: ExchangeRecordDescriptor[];
    fields: ExchangeField[];
    rules: ExchangeRule[];
    actions: ExchangeAction[];
    projections: ExchangeProjectionDescriptor[];
  };
  diagnostics: string[];
}

export function isRecordMap(value: unknown): value is RecordMap {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function records(value: unknown): RecordMap[] {
  return Array.isArray(value) ? value.filter(isRecordMap) : [];
}

function bindingList(value: unknown): Array<{ from: string; to: string }> {
  return records(value)
    .map((entry) => ({ from: text(entry.from), to: text(entry.to) }))
    .filter((entry) => entry.from && entry.to);
}

function recordDescriptors(value: unknown): ExchangeRecordDescriptor[] {
  return records(value).map((entry, index) => ({
    id: text(entry.id, `record-descriptor:${index}`),
    label: text(entry.label, `Record ${index + 1}`),
    fieldRefs: stringList(entry.field_refs ?? entry.fieldRefs),
    relationshipRefs: stringList(entry.relationship_refs ?? entry.relationshipRefs),
    ruleRefs: stringList(entry.rule_refs ?? entry.ruleRefs),
    actionRefs: stringList(entry.action_refs ?? entry.actionRefs),
    projectionRefs: stringList(entry.projection_refs ?? entry.projectionRefs),
  }));
}

function fields(value: unknown): ExchangeField[] {
  return records(value)
    .map((entry, index) => ({
      id: text(entry.id, `field:${index}`),
      label: text(entry.label, `Field ${index + 1}`),
      role: text(entry.role, 'line'),
      valuePath: text(entry.value_path ?? entry.valuePath, text(entry.id)),
      order: numberValue(entry.order, index),
    }))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function rules(value: unknown): ExchangeRule[] {
  return records(value).map((entry, index) => ({
    id: text(entry.id, `rule:${index}`),
    label: text(entry.label, `Rule ${index + 1}`),
    method: text(entry.method, 'unknown'),
    params: isRecordMap(entry.params) ? entry.params : {},
  }));
}

function actions(value: unknown): ExchangeAction[] {
  return records(value).map((entry, index) => ({
    id: text(entry.id, `action:${index}`),
    label: text(entry.label, `Action ${index + 1}`),
    target: text(entry.target, 'slot::workflow'),
    targetOwnerRef: text(entry.target_owner_ref ?? entry.targetOwnerRef),
    operationRef: text(entry.operation_ref ?? entry.operationRef, 'workflow:execute_definition'),
    definitionRef: text(entry.definition_ref ?? entry.definitionRef) || undefined,
    inputBindings: bindingList(entry.input_bindings ?? entry.inputBindings),
    ruleRefs: stringList(entry.rule_refs ?? entry.ruleRefs),
    resultProjectionRef: text(entry.result_projection_ref ?? entry.resultProjectionRef) || undefined,
  }));
}

function projections(value: unknown): ExchangeProjectionDescriptor[] {
  return records(value)
    .map((entry, index) => {
      const sectionLabels = entry.section_labels ?? entry.sectionLabels;
      return {
        id: text(entry.id, `projection:${index}`),
        label: text(entry.label, `Projection ${index + 1}`),
        slotRefs: stringList(entry.slot_refs ?? entry.slotRefs),
        actionRefs: stringList(entry.action_refs ?? entry.actionRefs),
        proofRelationshipRefs: stringList(entry.proof_relationship_refs ?? entry.proofRelationshipRefs),
        sectionLabels: isRecordMap(sectionLabels) ? sectionLabels : {},
        order: numberValue(entry.order, index),
      };
    })
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function exchangeRecords(value: unknown): ExchangeRecord[] {
  return records(value)
    .map((entry, index) => {
      const id = text(entry.id ?? entry.ref, `exchange-record:${index}`);
      return {
        id,
        descriptorRef: text(entry.descriptor_ref ?? entry.descriptorRef),
        title: text(entry.title ?? entry.label, id),
        values: entry,
      };
    })
    .filter((entry) => entry.descriptorRef);
}

function relationships(value: unknown): ExchangeRelationship[] {
  return records(value).map((entry, index) => ({
    id: text(entry.id, `relationship:${index}`),
    sourceRef: text(entry.source_ref ?? entry.sourceRef),
    relationshipRef: text(entry.relationship_ref ?? entry.relationshipRef),
    targetRef: text(entry.target_ref ?? entry.targetRef),
    label: text(entry.label ?? entry.title, text(entry.target_ref ?? entry.targetRef)),
  }));
}

function valueAt(record: RecordMap, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split('.').filter(Boolean)) {
    if (!isRecordMap(current)) return undefined;
    current = current[part];
  }
  return current;
}

function relationshipsFor(recordRef: string, relationRef: string, all: ExchangeRelationship[]): ExchangeRelationship[] {
  return all.filter((entry) => entry.sourceRef === recordRef && entry.relationshipRef === relationRef);
}

function evaluateRule(
  rule: ExchangeRule,
  record: ExchangeRecord,
  allRelationships: ExchangeRelationship[],
): RuleResult {
  const relationRef = text(rule.params.relationship_ref ?? rule.params.relationshipRef);
  const matches = relationRef ? relationshipsFor(record.id, relationRef, allRelationships) : [];
  const state = (pass: boolean) => ({
    stateLabel: text(rule.params[pass ? 'pass_label' : 'fail_label'] ?? rule.params[pass ? 'passLabel' : 'failLabel'], rule.label),
    stateTone: text(rule.params[pass ? 'pass_tone' : 'fail_tone'] ?? rule.params[pass ? 'passTone' : 'failTone']) || undefined,
  });
  if (rule.method === 'record-relationship-exists') {
    const pass = matches.length > 0;
    return {
      ruleRef: rule.id,
      label: rule.label,
      pass,
      ...state(pass),
      resultRef: pass ? undefined : text(rule.params.missing_result_ref ?? rule.params.missingResultRef),
    };
  }
  if (rule.method === 'record-relationship-absent') {
    const pass = matches.length === 0;
    return {
      ruleRef: rule.id,
      label: rule.label,
      pass,
      ...state(pass),
      resultRef: pass ? undefined : text(rule.params.present_result_ref ?? rule.params.presentResultRef),
    };
  }
  if (rule.method === 'owner-target-ready') {
    const pass = matches.length > 0;
    return {
      ruleRef: rule.id,
      label: rule.label,
      pass,
      ...state(pass),
      resultRef: pass ? undefined : text(rule.params.missing_result_ref ?? rule.params.missingResultRef),
    };
  }
  return {
    ruleRef: rule.id,
    label: rule.label,
    pass: false,
    stateLabel: rule.label,
    stateTone: undefined,
    resultRef: `unknown-rule-method:${rule.method}`,
    detail: rule.method,
  };
}

function projectRecord(
  record: ExchangeRecord,
  descriptor: ExchangeRecordDescriptor,
  fieldsById: Map<string, ExchangeField>,
  rulesById: Map<string, ExchangeRule>,
  actionsById: Map<string, ExchangeAction>,
  allRelationships: ExchangeRelationship[],
  proofs: RecordMap[],
): ProjectedRecord {
  const projectedFields = descriptor.fieldRefs
    .map((fieldRef) => fieldsById.get(fieldRef))
    .filter((field): field is ExchangeField => !!field)
    .map((field) => ({
      fieldRef: field.id,
      label: field.label,
      role: field.role,
      value: valueAt(record.values, field.valuePath),
    }));
  const related = allRelationships.filter((entry) => entry.sourceRef === record.id);
  const ruleResults = descriptor.ruleRefs
    .map((ruleRef) => rulesById.get(ruleRef))
    .filter((rule): rule is ExchangeRule => !!rule)
    .map((rule) => evaluateRule(rule, record, allRelationships));
  const projectedActions = descriptor.actionRefs
    .map((actionRef) => actionsById.get(actionRef))
    .filter((action): action is ExchangeAction => !!action)
    .map((action) => {
      const actionRules = action.ruleRefs.length > 0
        ? ruleResults.filter((result) => action.ruleRefs.includes(result.ruleRef))
        : ruleResults;
      const reasonRefs = actionRules.filter((result) => !result.pass).map((result) => result.resultRef ?? result.ruleRef);
      return {
        actionRef: action.id,
        label: action.label,
        target: action.target,
        targetOwnerRef: action.targetOwnerRef,
        operationRef: action.operationRef,
        definitionRef: action.definitionRef,
        available: reasonRefs.length === 0,
        reasonRefs,
      };
    });
  const proofIds = new Set(
    related
      .filter((entry) => entry.relationshipRef.includes('proof') || entry.relationshipRef.includes('process'))
      .map((entry) => entry.targetRef),
  );
  return {
    recordRef: record.id,
    descriptorRef: descriptor.id,
    title: record.title,
    fields: projectedFields,
    relationships: related,
    rules: ruleResults,
    actions: projectedActions,
    proofs: proofs.filter((entry) => proofIds.has(text(entry.id ?? entry.ref))),
  };
}

export function readRecordExchangeProjection(input: ExchangeBundleInput): RecordExchangeProjection {
  const descriptorBundle = input.descriptors ?? {};
  const factBundle = input.facts ?? {};
  const descriptorList = recordDescriptors(descriptorBundle.record_descriptors ?? descriptorBundle.recordDescriptors);
  const fieldList = fields(descriptorBundle.field_descriptors ?? descriptorBundle.fieldDescriptors);
  const ruleList = rules(descriptorBundle.rule_descriptors ?? descriptorBundle.ruleDescriptors);
  const actionList = actions(descriptorBundle.owner_action_descriptors ?? descriptorBundle.ownerActionDescriptors);
  const projectionList = projections(descriptorBundle.projection_descriptors ?? descriptorBundle.projectionDescriptors);
  const sourceRecords = exchangeRecords(input.records ?? factBundle.records);
  const sourceRelationships = relationships(input.relationships ?? factBundle.relationships);
  const sourceProofs = records(input.proofs ?? factBundle.proofs);
  const descriptorsById = new Map(descriptorList.map((entry) => [entry.id, entry]));
  const fieldsById = new Map(fieldList.map((entry) => [entry.id, entry]));
  const rulesById = new Map(ruleList.map((entry) => [entry.id, entry]));
  const actionsById = new Map(actionList.map((entry) => [entry.id, entry]));
  const diagnostics: string[] = [];
  const projectedRecords = sourceRecords
    .map((record) => {
      const descriptor = descriptorsById.get(record.descriptorRef);
      if (!descriptor) {
        diagnostics.push(`missing-descriptor:${record.id}:${record.descriptorRef}`);
        return undefined;
      }
      return projectRecord(record, descriptor, fieldsById, rulesById, actionsById, sourceRelationships, sourceProofs);
    })
    .filter((record): record is ProjectedRecord => !!record);
  return {
    records: projectedRecords,
    descriptors: {
      records: descriptorList,
      fields: fieldList,
      rules: ruleList,
      actions: actionList,
      projections: projectionList,
    },
    diagnostics,
  };
}
