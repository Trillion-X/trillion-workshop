// package-set://bitfield-studio/packages/product-access/read-data/access-control-projection.ts

import {
  type AccessControlDecodeResult,
  type AccessControlProjectionConfig,
  type AccessControlRecord,
  type DecodeProblem,
  type OwnerActionIntentDescriptor,
  record,
  text,
} from './access-control-records';

export interface AccessItemStatus {
  key: string;
  label: string;
  tone?: string;
  rank?: number;
}

export interface ProductAccessActionDescriptor {
  id: string;
  label: string;
  target: string;
  enabled: boolean;
  disabledReason?: string;
  request: unknown;
  processSessionRef?: string;
  metadata: Record<string, unknown>;
}

export interface ProductAccessLine {
  id: string;
  label: string;
  value: string;
}

export interface ProductAccessProofRow {
  id: string;
  label: string;
  value: string;
}

export interface ProductAccessItem {
  id: string;
  kind: string;
  title: string;
  status: AccessItemStatus;
  lines: ProductAccessLine[];
  relationships: Array<{ kind: string; to: string; fields: Record<string, unknown> }>;
  rules: Array<{ method: string; params: Record<string, unknown>; writes: string[] }>;
  actions: ProductAccessActionDescriptor[];
  verificationRows: ProductAccessProofRow[];
  processSessionRefs: string[];
  fields: Record<string, unknown>;
}

export interface ProductAccessView {
  title: string;
  accessItems: ProductAccessItem[];
  freshness: {
    label: string;
    tone?: string;
    stale: boolean;
    disabledReason?: string;
  };
  projectionProblems: DecodeProblem[];
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function line(value: unknown): ProductAccessLine | null {
  const row = record(value);
  const id = text(row.id);
  const label = text(row.label);
  const lineValue = text(row.value);
  if (!id || !label || !lineValue) return null;
  return { id, label, value: lineValue };
}

function statusFrom(recordEntry: AccessControlRecord, problems: DecodeProblem[]): AccessItemStatus {
  const status = record(recordEntry.display.status);
  const key = text(status.key);
  const label = text(status.label);
  if (!key || !label) {
    problems.push({
      id: `${recordEntry.id}:missing-status`,
      title: 'Access record is missing status data',
      detail: 'Status key and label must be supplied by package data.',
    });
  }
  return {
    key,
    label,
    tone: text(status.tone) || undefined,
    rank: number(status.rank),
  };
}

function linesFrom(recordEntry: AccessControlRecord): ProductAccessLine[] {
  const displayLines = Array.isArray(recordEntry.display.lines) ? recordEntry.display.lines.map(line) : [];
  return displayLines.filter((entry): entry is ProductAccessLine => entry !== null);
}

function actionFrom(action: OwnerActionIntentDescriptor, staleReason?: string): ProductAccessActionDescriptor {
  return {
    id: action.id,
    label: action.label,
    target: action.target,
    enabled: staleReason ? false : action.enabled,
    disabledReason: staleReason || action.disabledReason,
    request: action.input,
    processSessionRef: action.processSessionRef,
    metadata: action.metadata,
  };
}

function projectionConfig(decode: AccessControlDecodeResult): AccessControlProjectionConfig {
  return decode.projections[0] ?? {
    id: 'access-control-projection:implicit',
    label: '',
    sourceRecordKind: 'access-control-record',
    freshness: { label: '', stale: false },
  };
}

export function projectAccessControlRecords(decode: AccessControlDecodeResult): ProductAccessView {
  const config = projectionConfig(decode);
  const problems = [...decode.problems];
  const staleReason = config.freshness.stale ? config.freshness.disabledReason || config.freshness.label : undefined;
  const accessItems = decode.records.map((recordEntry) => ({
    id: recordEntry.id,
    kind: recordEntry.kind,
    title: recordEntry.label,
    status: statusFrom(recordEntry, problems),
    lines: linesFrom(recordEntry),
    relationships: recordEntry.relationships,
    rules: recordEntry.rules,
    actions: recordEntry.actions.map((action) => actionFrom(action, staleReason)),
    verificationRows: recordEntry.proofs.map((proof) => ({ id: proof.id, label: proof.label, value: proof.value })),
    processSessionRefs: recordEntry.processSessions.map((session) => session.ref),
    fields: recordEntry.fields,
  }));

  return {
    title: config.label,
    accessItems: accessItems.sort((left, right) => {
      const rankDelta = (left.status.rank ?? Number.MAX_SAFE_INTEGER) - (right.status.rank ?? Number.MAX_SAFE_INTEGER);
      return rankDelta === 0 ? left.title.localeCompare(right.title) : rankDelta;
    }),
    freshness: config.freshness,
    projectionProblems: problems,
  };
}
