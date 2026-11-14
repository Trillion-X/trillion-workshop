import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  readCapabilityActionDescriptor,
  record,
  text,
  type CapabilityActionDescriptor,
} from '../read-data/capability-state-records';
import { recordCapabilityAttempt, type CapabilityActionAttemptRecord } from './record-capability-attempt';

export interface CapabilityActionDispatch {
  target: string;
  input: unknown;
  actionId: string;
  requestId?: string;
}

export interface CapabilityActionDispatchResult {
  ok: boolean;
  requestId?: string;
  processSessionRef?: string;
  evidenceRefs?: string[];
  output?: unknown;
  error?: string;
}

export type CapabilityActionSender =
  (dispatch: CapabilityActionDispatch) => CapabilityActionDispatchResult | Promise<CapabilityActionDispatchResult>;

export interface CapabilityActionInvocationRecord extends CapabilityActionAttemptRecord {
  outcome: 'sent' | 'not-sent' | 'failed';
  output?: unknown;
  error?: string;
}

function invocationRecord(
  action: CapabilityActionDescriptor,
  fields: Omit<CapabilityActionInvocationRecord, 'kind' | 'id' | 'descriptorRef' | 'ownerTargetRef'>,
): CapabilityActionInvocationRecord {
  return {
    kind: 'capability-action-attempt-record',
    id: fields.correlationRef || `${action.id}:attempt`,
    descriptorRef: action.id,
    ownerTargetRef: action.target,
    ...fields,
  };
}

export async function invokeCapabilityActionDescriptor(
  descriptor: CapabilityActionDescriptor | Record<string, unknown>,
  send: CapabilityActionSender = async (dispatch) => {
    const reply = await sendRequestToBitfieldTarget({ target: dispatch.target, payload: dispatch.input });
    return { ok: true, requestId: dispatch.requestId, output: reply };
  },
  requestId?: string,
): Promise<CapabilityActionInvocationRecord> {
  const action = readCapabilityActionDescriptor(descriptor);
  if (!action) {
    const fallback = {
      id: text(record(descriptor).id) || 'unknown-action',
      label: '',
      target: text(record(descriptor).target) || 'unknown-target',
      enabled: false,
      input: {},
      metadata: {},
    };
    return invocationRecord(fallback, {
      correlationRef: requestId,
      dispatched: false,
      outcome: 'failed',
      error: 'capability action descriptor is malformed',
    });
  }
  if (!action.enabled) {
    return invocationRecord(action, {
      correlationRef: requestId,
      dispatched: false,
      outcome: 'not-sent',
      disabledReason: action.disabledReason || 'Action is disabled by descriptor data',
      processSessionRef: action.processSessionRef,
    });
  }

  try {
    const result = await send({ target: action.target, input: action.input, actionId: action.id, requestId });
    return invocationRecord(action, {
      correlationRef: result.requestId || requestId,
      dispatched: true,
      outcome: result.ok ? 'sent' : 'failed',
      processSessionRef: result.processSessionRef || action.processSessionRef,
      output: result.output,
      error: result.error,
      evidenceRefs: result.evidenceRefs,
    });
  } catch (error) {
    return invocationRecord(action, {
      correlationRef: requestId,
      dispatched: true,
      outcome: 'failed',
      processSessionRef: action.processSessionRef,
      error: error instanceof Error ? error.message : 'capability action dispatch failed',
    });
  }
}

export async function invokeCapabilityActionTarget(
  input: unknown,
  _context?: unknown,
  send?: CapabilityActionSender,
) {
  const row = record(input);
  return invokeCapabilityActionDescriptor(
    record(row.action ?? row.descriptor),
    send,
    text(row.request_id ?? row.requestId) || undefined,
  );
}

export function capabilityAttemptFromInvocation(invocation: CapabilityActionInvocationRecord) {
  return recordCapabilityAttempt({
    descriptorRef: invocation.descriptorRef,
    ownerTargetRef: invocation.ownerTargetRef,
    correlationRef: invocation.correlationRef,
    processSessionRef: invocation.processSessionRef,
    evidenceRefs: invocation.evidenceRefs,
    fields: {
      dispatched: invocation.dispatched,
      outcome: invocation.outcome,
      disabled_reason: invocation.disabledReason,
      error: invocation.error,
    },
  });
}
