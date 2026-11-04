// PORTED FROM: bitfield-packages/packages/operation-records/do-work/invoke-operation-transition.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { buildOperationActionInvocationDescriptor } from '../read-data/operation-action-invocation';
import type { OperationClaim, OperationRecord, OperationTransition } from '../read-data/operation-records';

export function buildOperationTransitionRequest(operation: OperationRecord, transition: OperationTransition, claim?: OperationClaim | null) {
  return buildOperationActionInvocationDescriptor(operation, transition, { claim });
}

export function invokeOperationTransition(
  operation: OperationRecord,
  transition: OperationTransition,
  claim?: OperationClaim | null,
): Promise<unknown> {
  return sendRequestToBitfieldTarget(buildOperationTransitionRequest(operation, transition, claim));
}
