import type { RecordMap } from '../read-data/read-record-exchange-projection';
import { isRecordMap } from '../read-data/read-record-exchange-projection';

export interface OwnerActionResultInput {
  actionRef: string;
  recordRef: string;
  resultRef: string;
  projectionRef?: string;
  proofRef?: string;
  payload?: RecordMap;
}

export interface OwnerActionProofRecord {
  kind: string;
  id: string;
  action_ref: string;
  record_ref: string;
  result_ref: string;
  projection_ref: string | null;
  payload: RecordMap;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function recordOwnerActionResult(input: OwnerActionResultInput): OwnerActionProofRecord {
  return {
    kind: 'record-exchange.owner-action-result',
    id: input.proofRef ?? `proof:${input.actionRef}:${input.recordRef}:${input.resultRef}`,
    action_ref: input.actionRef,
    record_ref: input.recordRef,
    result_ref: input.resultRef,
    projection_ref: input.projectionRef ?? null,
    payload: input.payload ?? {},
  };
}

export function recordOwnerActionResultTarget(request: unknown): OwnerActionProofRecord {
  if (!isRecordMap(request)) throw new Error('record-exchange-result-request-invalid');
  return recordOwnerActionResult({
    actionRef: text(request.actionRef ?? request.action_ref),
    recordRef: text(request.recordRef ?? request.record_ref),
    resultRef: text(request.resultRef ?? request.result_ref),
    projectionRef: text(request.projectionRef ?? request.projection_ref) || undefined,
    proofRef: text(request.proofRef ?? request.proof_ref) || undefined,
    payload: isRecordMap(request.payload) ? request.payload : undefined,
  });
}

