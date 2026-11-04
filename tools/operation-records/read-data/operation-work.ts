// PORTED FROM: bitfield-packages/packages/operation-records/read-data/operation-work.ts @ e99ac5976
import {
  decodeOperationClaims,
  decodeOperationRecords,
  isCurrentOperationClaim,
  record,
  type OperationClaim,
  type OperationRecord,
  type OperationTransition,
} from './operation-records';

export interface OperationWorkItem {
  operation: OperationRecord;
  claim: OperationClaim | null;
  executableTransitions: OperationTransition[];
  blockedTransitions: OperationTransition[];
}

export interface OperationWorkSurface {
  items: OperationWorkItem[];
  focus: OperationWorkItem | null;
  activeCount: number;
  claimCount: number;
}

export function decodeOperationWorkSurface(raw: unknown, nowIso?: string): OperationWorkSurface {
  const source = record(raw);
  const operations = decodeOperationRecords(Array.isArray(raw) ? raw : source.operations ?? source.operation_records);
  const claims = Array.isArray(raw) ? [] : decodeOperationClaims(source.claims ?? source.operation_claims);
  const items = operations.map((operation): OperationWorkItem => {
    const claim = claims.find((candidate) => isCurrentOperationClaim(candidate, operation.id, nowIso)) ?? null;
    return {
      operation,
      claim,
      executableTransitions: operation.transitions.filter((transition) => !transition.requiresClaim || claim !== null),
      blockedTransitions: operation.transitions.filter((transition) => transition.requiresClaim && claim === null),
    };
  });
  return { items, focus: items[0] ?? null, activeCount: items.length, claimCount: claims.length };
}
