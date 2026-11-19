// PORTED FROM: bitfield-packages/packages/operation-records/do-work/invoke-operation-transition.ts @ e99ac5976
import { buildOperationActionInvocationDescriptor } from '../read-data/operation-action-invocation';
import type { OperationClaim, OperationRecord, OperationTransition } from '../read-data/operation-records';

export function buildOperationTransitionRequest(operation: OperationRecord, transition: OperationTransition, claim?: OperationClaim | null) {
  return buildOperationActionInvocationDescriptor(operation, transition, { claim });
}

// The send to the retired Bitfield runtime is removed. Until a declared route exists, a transition is not sent: the caller
// gets this error, and the correction it was making is not delivered.
export function invokeOperationTransition(
  operation: OperationRecord,
  transition: OperationTransition,
  claim?: OperationClaim | null,
): Promise<unknown> {
  return Promise.reject(new Error(`No route sends operation transition ${buildOperationTransitionRequest(operation, transition, claim).transitionRef}: the retired runtime send is removed.`));
}
