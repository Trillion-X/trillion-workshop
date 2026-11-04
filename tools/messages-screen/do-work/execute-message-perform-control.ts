// PORTED FROM: bitfield-packages/packages/chat/do-work/execute-message-perform-control.ts @ e99ac5976
import {
  authorizeRoundCapability,
  executeChatWorkRequests,
  parseChatWorkRequests,
  type ChatWorkRequestResult,
} from './execute-chat-work-requests';
import type { ChatWorkflowAction } from '../read-data/read-chat-work-actions';
import type {
  AgentMessage,
  MessagePerformControl,
  MessagePerformResult,
} from '../read-data/chat-message-types';

type ExecuteRequests = typeof executeChatWorkRequests;

function workRequestText(control: MessagePerformControl): string {
  return `\`\`\`bitfield-work-request\n${JSON.stringify({
    capabilityRef: control.perform.capabilityRef,
    input: control.perform.input,
    proofRefs: control.perform.proofRefs ?? [],
  })}\n\`\`\``;
}

/**
 * Runs one human-selected message control through the same exact-owner workflow
 * hydration and execution path used by agentic chat work. The click grants one
 * capability, for one message, for one short-lived round. It never authorizes
 * an action id, raw target, or later replay.
 */
export async function executeMessagePerformControl(input: {
  message: AgentMessage;
  control: MessagePerformControl;
  workflowActions: readonly ChatWorkflowAction[];
  callerAuthorityRef: string;
  partitionKey?: string | null;
  executeRequests?: ExecuteRequests;
}): Promise<MessagePerformResult> {
  if (!input.callerAuthorityRef) {
    return { status: 'failed', message: 'This action has no current human authority.', evidenceRefs: [] };
  }
  if (input.control.perform.authorityRef
    && input.control.perform.authorityRef !== input.callerAuthorityRef) {
    return { status: 'failed', message: 'This action belongs to a different authority.', evidenceRefs: [] };
  }
  const attached = input.message.performControls?.filter((control) => control.id === input.control.id) ?? [];
  if (attached.length !== 1 || JSON.stringify(attached[0]) !== JSON.stringify(input.control)) {
    return { status: 'failed', message: 'This control does not match the effect on this message.', evidenceRefs: [] };
  }
  const assistantText = workRequestText(attached[0]);

  const round = 0;
  const authorization = authorizeRoundCapability({
    turnId: input.message.id,
    round,
    callerAuthorityRef: input.callerAuthorityRef,
    ttlMs: 30_000,
    now: Date.now(),
    capabilities: [input.control.perform.capabilityRef],
    requests: parseChatWorkRequests(assistantText),
  });
  const execute = input.executeRequests ?? executeChatWorkRequests;
  const results: ChatWorkRequestResult[] = await execute({
    assistantText,
    workflowActions: input.workflowActions,
    authorization,
    turnId: input.message.id,
    round,
    callerAuthorityRef: input.callerAuthorityRef,
    partitionKey: input.partitionKey,
  });
  const result = results[0];
  if (!result) return { status: 'failed', message: 'The action did not return a result.', evidenceRefs: [] };
  if (result.accepted && result.status === 'completed') {
    return { status: 'started', message: input.control.successLabel ?? 'Work started', evidenceRefs: result.evidenceRefs };
  }
  if (result.status === 'unknown_outcome') {
    return { status: 'unknown_outcome', message: 'Work may have started. Checking what happened.', evidenceRefs: result.evidenceRefs };
  }
  return { status: 'failed', message: result.error ?? 'Work did not start.', evidenceRefs: result.evidenceRefs };
}
