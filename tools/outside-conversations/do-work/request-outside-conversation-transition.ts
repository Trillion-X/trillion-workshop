import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

import {
  buildGenericRecordWorkActionRequest,
  type GenericRecordWorkActionInput,
} from './generic-record-work-actions.ts';
import type { WorkGraphAction } from '../read-data/generic-record-work-graph.ts';

export interface OutsideConversationReceipt {
  actionId: string;
  correlationRef: string;
  envelopeTarget: string;
  operationRef: string;
  submittedAt: string;
  summary: string;
  visibleState: string;
  workflowActionId?: string;
}

export interface StartOutsideConversationInput {
  action: WorkGraphAction;
  values?: Record<string, unknown>;
  now?: Date;
  requestText?: string;
}

export interface OutsideConversationTransitionInput extends GenericRecordWorkActionInput {
  correlationRef?: string;
  effectRef?: string;
  authorizationRef?: string;
}

function compactText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : fallback;
}

function operationRef(action: WorkGraphAction, submittedAt: string): string {
  return `${action.id}:${submittedAt}`;
}

export function buildOutsideConversationWorkflowRequest(
  action: WorkGraphAction,
  input: Record<string, unknown> = {},
) {
  return buildGenericRecordWorkActionRequest({ action, values: input });
}

export function buildOpenOutsideConversationSubmission(input: StartOutsideConversationInput) {
  const submittedAt = (input.now ?? new Date()).toISOString();
  const summary = compactText(input.requestText ?? input.values?.summary, input.action.label);
  const values = {
    ...(input.values ?? {}),
    summary,
    submitted_at: submittedAt,
  };
  const request = buildGenericRecordWorkActionRequest({ action: input.action, values });

  return {
    request,
    receipt: {
      actionId: input.action.id,
      correlationRef: operationRef(input.action, submittedAt),
      envelopeTarget: input.action.target,
      operationRef: operationRef(input.action, submittedAt),
      submittedAt,
      summary,
      visibleState: input.action.disabledReason ?? 'saved',
      workflowActionId: input.action.definitionId,
    } satisfies OutsideConversationReceipt,
  };
}

export function buildOutsideConversationTransitionRequest(input: OutsideConversationTransitionInput) {
  return buildGenericRecordWorkActionRequest({
    ...input,
    values: {
      ...(input.values ?? {}),
      correlation_ref: input.correlationRef,
      effect_ref: input.effectRef,
      authorization_ref: input.authorizationRef,
    },
  });
}

export function buildOpenOutsideConversationInput(input: StartOutsideConversationInput): Record<string, unknown> {
  return buildOpenOutsideConversationSubmission(input).request.payload.input;
}

export function buildRecordOutsideConversationExecutionHandoffInput(input: OutsideConversationTransitionInput): Record<string, unknown> {
  return buildGenericRecordWorkActionRequest(input).payload.input;
}

export function buildRecordOutsideConversationExecutionHandoffRequest(input: OutsideConversationTransitionInput) {
  return buildGenericRecordWorkActionRequest(input);
}

export function requestOutsideConversationTransition(input: OutsideConversationTransitionInput): Promise<void> {
  return sendRequestToBitfieldTarget(buildOutsideConversationTransitionRequest(input)).then(() => undefined);
}

export function startOutsideConversation(input: StartOutsideConversationInput): Promise<OutsideConversationReceipt> {
  const submission = buildOpenOutsideConversationSubmission(input);
  return sendRequestToBitfieldTarget(submission.request).then(() => submission.receipt);
}
