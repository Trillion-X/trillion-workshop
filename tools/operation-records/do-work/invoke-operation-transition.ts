// PORTED FROM: bitfield-packages/packages/operation-records/do-work/invoke-operation-transition.ts @ e99ac5976
// The transition's request descriptor is buildOperationActionInvocationDescriptor (read-data/operation-action-invocation.ts); this
// file had only a wrapper for it, with no caller left, so the wrapper is retired and the descriptor is unchanged.
import type { OperationClaim, OperationRecord, OperationTransition } from '../read-data/operation-records';

export interface CorrectionHandedOff {
  status: 'handed-off';
  performed: false;
  handoff_ref: string;
}

// The send to the retired Bitfield runtime is removed (its runtime is retired: the ruling in the project's CLAUDE.md, source-tree section). The
// correction is durable without it: the conversation owner writes the correction handoff row with the turn, atomically
// (messages-screen/packages/conversations/do-work/exchange-target.ts, the handoff record). This resolves with that handoff ref and
// says the transition itself was not performed; nothing reads the handoff row yet, so the operation's state does not change.
export function invokeOperationTransition(
  operation: OperationRecord,
  transition: OperationTransition,
  claim?: OperationClaim | null,
): Promise<CorrectionHandedOff> {
  const handoffRef = transition.input.correction_handoff_ref;
  if (typeof handoffRef !== 'string' || !handoffRef) {
    return Promise.reject(new Error(`Operation transition ${transition.id} has no correction handoff to carry it.`));
  }
  return Promise.resolve({ status: 'handed-off', performed: false, handoff_ref: handoffRef });
}
