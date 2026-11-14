// package-set://bitfield-studio/packages/product-access/read-data/access-control-records.ts

export interface AccessRelationshipDescriptor {
  kind: string;
  to: string;
  fields: Record<string, unknown>;
}

export interface AccessRuleDescriptor {
  method: string;
  params: Record<string, unknown>;
  writes: string[];
}

export interface OwnerActionIntentDescriptor {
  id: string;
  label: string;
  target: string;
  input: unknown;
  enabled: boolean;
  disabledReason?: string;
  processSessionRef?: string;
  metadata: Record<string, unknown>;
}

export interface AccessProofDescriptor {
  id: string;
  label: string;
  value: string;
  fields: Record<string, unknown>;
}

export interface ProcessSessionReceiptRef {
  ref: string;
  label?: string;
  fields: Record<string, unknown>;
}

export interface AccessControlRecord {
  id: string;
  kind: string;
  label: string;
  fields: Record<string, unknown>;
  display: Record<string, unknown>;
  relationships: AccessRelationshipDescriptor[];
  rules: AccessRuleDescriptor[];
  actions: OwnerActionIntentDescriptor[];
  proofs: AccessProofDescriptor[];
  processSessions: ProcessSessionReceiptRef[];
}

export interface AccessControlProjectionConfig {
  id: string;
  label: string;
  sourceRecordKind: string;
  freshness: {
    label: string;
    tone?: string;
    stale: boolean;
    disabledReason?: string;
  };
}

export interface DecodeProblem {
  id: string;
  title: string;
  detail?: string;
}

export interface AccessControlDecodeResult {
  records: AccessControlRecord[];
  projections: AccessControlProjectionConfig[];
  problems: DecodeProblem[];
}

export type PackageThing = {
  payload?: unknown;
};

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function textList(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function problem(id: string, title: string, detail?: string): DecodeProblem {
  return detail ? { id, title, detail } : { id, title };
}

function readRelationship(value: unknown): AccessRelationshipDescriptor | null {
  const row = record(value);
  const kind = text(row.kind);
  const to = text(row.to);
  if (!kind || !to) return null;
  return { kind, to, fields: record(row.fields) };
}

function readRule(value: unknown): AccessRuleDescriptor | null {
  const row = record(value);
  const method = text(row.method);
  if (!method) return null;
  return { method, params: record(row.params), writes: textList(row.writes) };
}

export function readOwnerActionIntent(value: unknown): OwnerActionIntentDescriptor | null {
  const row = record(value);
  const id = text(row.id);
  const label = text(row.label);
  const target = text(row.target);
  if (!id || !label || !target) return null;
  return {
    id,
    label,
    target,
    input: row.input ?? {},
    enabled: bool(row.enabled, true),
    disabledReason: text(row.disabled_reason ?? row.disabledReason) || undefined,
    processSessionRef: text(row.process_session_ref ?? row.processSessionRef) || undefined,
    metadata: record(row.metadata),
  };
}

function readProof(value: unknown): AccessProofDescriptor | null {
  const row = record(value);
  const id = text(row.id);
  const label = text(row.label);
  const proofValue = text(row.value);
  if (!id || !label || !proofValue) return null;
  return { id, label, value: proofValue, fields: record(row.fields) };
}

function readProcessSessionRef(value: unknown): ProcessSessionReceiptRef | null {
  const row = record(value);
  const ref = text(row.ref);
  if (!ref) return null;
  return { ref, label: text(row.label) || undefined, fields: record(row.fields) };
}

function readAccessControlRecord(value: unknown, index: number, problems: DecodeProblem[]): AccessControlRecord | null {
  const row = record(value);
  if (text(row.kind) !== 'access-control-record') return null;
  const id = text(row.id);
  const recordKind = text(row.record_kind ?? row.recordKind);
  const label = text(row.label);
  const problemId = id || `access-control-record:${index}`;
  if (!id) problems.push(problem(`${problemId}:missing-id`, 'Access record is missing an id'));
  if (!recordKind) problems.push(problem(`${problemId}:missing-kind`, 'Access record is missing a record kind'));
  if (!label) problems.push(problem(`${problemId}:missing-label`, 'Access record is missing a human label'));
  if (!id || !recordKind || !label) return null;

  return {
    id,
    kind: recordKind,
    label,
    fields: record(row.fields),
    display: record(row.display),
    relationships: list(row.relationships).map(readRelationship).filter((entry): entry is AccessRelationshipDescriptor => entry !== null),
    rules: list(row.rules).map(readRule).filter((entry): entry is AccessRuleDescriptor => entry !== null),
    actions: list(row.actions).map(readOwnerActionIntent).filter((entry): entry is OwnerActionIntentDescriptor => entry !== null),
    proofs: list(row.proofs).map(readProof).filter((entry): entry is AccessProofDescriptor => entry !== null),
    processSessions: list(row.process_sessions ?? row.processSessions)
      .map(readProcessSessionRef)
      .filter((entry): entry is ProcessSessionReceiptRef => entry !== null),
  };
}

function readProjectionConfig(value: unknown): AccessControlProjectionConfig | null {
  const row = record(value);
  if (text(row.kind) !== 'access-control-projection-record') return null;
  const id = text(row.id);
  const label = text(row.label);
  const sourceRecordKind = text(row.source_record_kind ?? row.sourceRecordKind) || 'access-control-record';
  if (!id || !label) return null;
  const freshness = record(row.freshness);
  return {
    id,
    label,
    sourceRecordKind,
    freshness: {
      label: text(freshness.label),
      tone: text(freshness.tone) || undefined,
      stale: bool(freshness.stale, false),
      disabledReason: text(freshness.disabled_reason ?? freshness.disabledReason) || undefined,
    },
  };
}

export function decodeAccessControlRecords(rawThings: readonly PackageThing[]): AccessControlDecodeResult {
  const problems: DecodeProblem[] = [];
  const payloads = rawThings.map((thing) => thing.payload);
  return {
    records: payloads
      .map((payload, index) => readAccessControlRecord(payload, index, problems))
      .filter((entry): entry is AccessControlRecord => entry !== null),
    projections: payloads
      .map(readProjectionConfig)
      .filter((entry): entry is AccessControlProjectionConfig => entry !== null),
    problems,
  };
}

