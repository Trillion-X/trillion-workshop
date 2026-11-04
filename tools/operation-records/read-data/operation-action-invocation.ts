// PORTED FROM: bitfield-packages/packages/operation-records/read-data/operation-action-invocation.ts @ e99ac5976
import { isCurrentOperationClaim, record } from './operation-records';
import type { OperationClaim, OperationRecord, OperationTransition } from './operation-records';

export interface OperationActionInvocationDescriptor {
  target: string;
  payload: {
    operation: 'execute_definition';
    definition_id: string;
    include_steps: false;
    include_output: false;
    input: Record<string, unknown>;
  };
  operationRef: string;
  transitionRef: string;
  claimRef?: string;
}

export interface OperationActionInvocationOptions {
  claim?: OperationClaim | null;
  nowIso?: string;
  requireClaim?: boolean;
}

export function buildOperationActionInvocationDescriptor(
  operation: OperationRecord,
  transition: OperationTransition,
  options: OperationActionInvocationOptions = {},
): OperationActionInvocationDescriptor {
  const attached = operation.transitions.filter((candidate) => candidate.id === transition.id);
  if (attached.length !== 1) throw new Error(`Transition ${transition.id} is not uniquely attached to operation ${operation.id}`);
  const owned = attached[0];
  const immutableKeys = [
    'ownerPackage', 'actionDefinitionId', 'target', 'idempotencyKey', 'sideEffectClass',
    'compensationActionRef', 'irreversibleEffectNotice', 'actorRef', 'requiresClaim',
  ] as const;
  if (immutableKeys.some((key) => owned[key] !== transition[key])) {
    throw new Error(`Transition ${transition.id} does not match its exact owner action`);
  }
  for (const [key, value] of Object.entries(owned.input)) {
    if (JSON.stringify(transition.input[key]) !== JSON.stringify(value)) {
      throw new Error(`Transition ${transition.id} changes owner input ${key}`);
    }
  }
  const addedKeys = Object.keys(transition.input).filter((key) => !(key in owned.input));
  const allowedReviewKeys = new Set(['review_reason', 'subject_ref', 'conversation_ref', 'correction_turn_ref', 'correction_handoff_ref']);
  const hasConversationCorrectionContext = addedKeys.includes('subject_ref')
    || addedKeys.includes('conversation_ref')
    || addedKeys.includes('correction_turn_ref')
    || addedKeys.includes('correction_handoff_ref');
  if (addedKeys.some((key) => !allowedReviewKeys.has(key))
    || (addedKeys.includes('review_reason') && !owned.modeHints.includes('requires-review-reason'))
    || (hasConversationCorrectionContext && (
      !owned.modeHints.includes('correction')
      || !addedKeys.includes('subject_ref')
      || !addedKeys.includes('conversation_ref')
      || !addedKeys.includes('correction_turn_ref')
      || !addedKeys.includes('correction_handoff_ref')
      || typeof transition.input.subject_ref !== 'string'
      || !transition.input.subject_ref.trim()
      || typeof transition.input.conversation_ref !== 'string'
      || !transition.input.conversation_ref.trim()
      || typeof transition.input.correction_turn_ref !== 'string'
      || !transition.input.correction_turn_ref.trim()
      || typeof transition.input.correction_handoff_ref !== 'string'
      || transition.input.correction_handoff_ref
        !== `package::conversations::background-work-correction-handoff::${transition.input.correction_turn_ref}`
    ))) {
    throw new Error(`Transition ${transition.id} adds unauthorized owner input`);
  }

  const mustHaveClaim = options.requireClaim || Boolean(owned.requiresClaim);
  if (mustHaveClaim && !options.claim) {
    throw new Error(`Transition ${transition.id} requires a current operation claim`);
  }
  if (options.claim && !isCurrentOperationClaim(options.claim, operation.id, options.nowIso)) {
    throw new Error(`Claim ${options.claim.id} is not current for operation ${operation.id}`);
  }

  const claimInput = options.claim
    ? {
        operationClaimId: options.claim.id,
        operationClaimToken: options.claim.claimToken,
        operationClaimActor: options.claim.actorRef,
      }
    : {};

  return {
    target: transition.target ?? 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: owned.actionDefinitionId,
      include_steps: false,
      include_output: false,
      input: {
        ...record(transition.input),
        operationId: operation.id,
        operationRef: operation.id,
        transitionId: transition.id,
        sourceRecord: operation.source,
        evidenceRefs: owned.evidenceRefs ?? [],
        candidateFactRefs: owned.candidateFactRefs ?? [],
        idempotencyKey: owned.idempotencyKey,
        ...claimInput,
      },
    },
    operationRef: operation.id,
    transitionRef: transition.id,
    ...(options.claim ? { claimRef: options.claim.id } : {}),
  };
}
