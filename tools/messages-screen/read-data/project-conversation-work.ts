// PORTED FROM: bitfield-packages/packages/chat/read-data/project-conversation-work.ts @ e99ac5976
import { decodeOperationWorkSurface } from '../../operation-records/read-data/operation-work';
import { buildOperationActionInvocationDescriptor } from '../../operation-records/read-data/operation-action-invocation';
import type {
  OperationClaim,
  OperationRecord,
  OperationTransition,
} from '../../operation-records/read-data/operation-records';
import type { AgentMessage, MessagePerformControl } from './chat-message-types';
import type { ChatWorkflowAction } from './read-chat-work-actions';
import { readConversationOwnerState } from './project-conversation-owner-events';

export interface ConversationCorrectionAction {
  operation: OperationRecord;
  transition: OperationTransition;
  claim: OperationClaim | null;
}

export interface ConversationWorkProjection {
  messages: AgentMessage[];
  correction: ConversationCorrectionAction | null;
}

function conversationAddress(conversationRef: string): string {
  return `package::conversations::addressed-exchange-conversation::${conversationRef}`;
}

function exactAction(
  actions: readonly ChatWorkflowAction[],
  transition: OperationTransition,
): ChatWorkflowAction | null {
  const matches = actions.filter((action) => action.active
    && action.actionId === transition.actionDefinitionId
    && action.sourcePackage === transition.ownerPackage);
  return matches.length === 1 ? matches[0] : null;
}

function ownerStateLabel(state: string | undefined): string {
  switch (state) {
    case 'approved':
    case 'done':
    case 'done-unapproved': return 'Done';
    case 'corrected-active':
    case 'running-corrected': return 'Working with your correction';
    case 'running': return 'Working';
    default: return state ? 'Work updated' : '';
  }
}

function controlFor(
  operation: OperationRecord,
  transition: OperationTransition,
  claim: OperationClaim | null,
  actions: readonly ChatWorkflowAction[],
): MessagePerformControl | null {
  const action = exactAction(actions, transition);
  if (!action) return null;
  try {
    const invocation = buildOperationActionInvocationDescriptor(operation, transition, { claim });
    return {
      id: transition.id,
      label: transition.label,
      pendingLabel: `${transition.label}…`,
      successLabel: `${transition.label} recorded`,
      perform: {
        ...(transition.actorRef ? { authorityRef: transition.actorRef } : {}),
        capabilityRef: action.capabilityRef,
        input: invocation.payload.input,
        proofRefs: [
          operation.source.id,
          ...operation.evidenceRefs,
          ...(transition.evidenceRefs ?? []),
          ...(transition.candidateFactRefs ?? []),
        ],
      },
    };
  } catch {
    // A blocked claim, detached transition, or altered owner action is visible as
    // status text but never becomes an executable Chat control.
    return null;
  }
}

function operationMessage(
  operation: OperationRecord,
  claim: OperationClaim | null,
  actions: readonly ChatWorkflowAction[],
  subjectRef: string,
  progressionRaw?: unknown,
): AgentMessage {
  const ownerState = readConversationOwnerState(progressionRaw, operation.id, subjectRef);
  const allowedModes = ownerState?.state === 'approved'
    || ownerState?.state === 'done'
    || ownerState?.state === 'done-unapproved'
      ? new Set(['compensation', 'correction'])
      : new Set(['owner-completion', 'correction']);
  const controls = operation.transitions
    .filter((transition) => transition.modeHints.some((hint) => allowedModes.has(hint)))
    .map((transition) => controlFor(operation, transition, claim, actions))
    .filter((control): control is MessagePerformControl => control !== null);
  const stateText = ownerStateLabel(ownerState?.state);
  const content = [
    `**${operation.display.title}**`,
    operation.display.status,
    operation.display.reason,
    ...operation.display.detail,
    stateText ? `Current status: ${stateText}` : '',
    ownerState?.correctedFactRefs.length ? 'Your correction is now being used.' : '',
    ownerState?.supersedesRefs.length ? 'The earlier information was replaced. Unrelated work was kept.' : '',
    ownerState?.retractsEffectRef ? 'The previous effect was undone. The conversation history is unchanged.' : '',
  ].filter(Boolean).join('\n\n');
  return {
    id: `conversation-work:${operation.id}`,
    type: 'text',
    role: 'assistant',
    content,
    timestamp: operation.updatedAt ?? operation.sortKey,
    atomRef: operation.id,
    nativeRef: operation.source.id,
    ...(controls.length ? { performControls: controls } : {}),
  };
}

/**
 * Projects only operations linked to this exact canonical Conversations address.
 * Unlinked and foreign-conversation work remains absent even when the upstream
 * Operation Records feed contains it. Owner rows stay canonical; Chat stores none.
 */
export function projectConversationWork(
  raw: unknown,
  conversationRef: string | null,
  subjectRef: string,
  workflowActions: readonly ChatWorkflowAction[],
  progressionRaw?: unknown,
): ConversationWorkProjection {
  if (!conversationRef) return { messages: [], correction: null };
  const expected = conversationAddress(conversationRef);
  const items = decodeOperationWorkSurface(raw).items
    .filter(({ operation }) => operation.linkRefs.filter((ref) => ref === expected).length === 1)
    .sort((left, right) => left.operation.sortKey.localeCompare(right.operation.sortKey));
  const correctionCandidates = items.flatMap(({ operation, claim }) => operation.transitions
    .filter((transition) => transition.modeHints.includes('correction'))
    .map((transition) => ({ operation, transition, claim })));
  return {
    messages: items.map(({ operation, claim }) => operationMessage(operation, claim, workflowActions, subjectRef, progressionRaw)),
    correction: correctionCandidates.length === 1 ? correctionCandidates[0] : null,
  };
}
