// package-set://bitfield-studio/packages/product-access/do-work/invoke-owner-action.ts

import {
  readOwnerActionIntent,
  record,
  text,
  type OwnerActionIntentDescriptor,
} from '../read-data/access-control-records';

export interface OwnerActionDispatch {
  target: string;
  input: unknown;
  actionId: string;
  requestId?: string;
}

export interface OwnerActionDispatchResult {
  ok: boolean;
  requestId?: string;
  processSessionRef?: string;
  output?: unknown;
  error?: string;
}

export type OwnerActionSender = (dispatch: OwnerActionDispatch) => OwnerActionDispatchResult | Promise<OwnerActionDispatchResult>;

export interface OwnerActionInvocationRecord {
  kind: 'owner-action-invocation-record';
  actionId: string;
  target: string;
  requestId?: string;
  dispatched: boolean;
  outcome: 'sent' | 'not-sent' | 'failed';
  disabledReason?: string;
  processSessionRef?: string;
  output?: unknown;
  error?: string;
}

function resultRecord(
  action: OwnerActionIntentDescriptor,
  fields: Omit<OwnerActionInvocationRecord, 'kind' | 'actionId' | 'target'>,
): OwnerActionInvocationRecord {
  return { kind: 'owner-action-invocation-record', actionId: action.id, target: action.target, ...fields };
}

export async function invokeOwnerActionDescriptor(
  descriptor: OwnerActionIntentDescriptor | Record<string, unknown>,
  send: OwnerActionSender,
  requestId?: string,
): Promise<OwnerActionInvocationRecord> {
  const action = readOwnerActionIntent(descriptor);
  if (!action) {
    const fallback = {
      id: text(record(descriptor).id) || 'unknown-action',
      target: text(record(descriptor).target) || 'unknown-target',
      label: '',
      input: {},
      enabled: false,
      metadata: {},
    };
    return resultRecord(fallback, {
      requestId,
      dispatched: false,
      outcome: 'failed',
      error: 'owner action descriptor is malformed',
    });
  }
  if (!action.enabled) {
    return resultRecord(action, {
      requestId,
      dispatched: false,
      outcome: 'not-sent',
      disabledReason: action.disabledReason || 'Action is disabled by descriptor data',
      processSessionRef: action.processSessionRef,
    });
  }

  try {
    const result = await send({ target: action.target, input: action.input, actionId: action.id, requestId });
    return resultRecord(action, {
      requestId: result.requestId || requestId,
      dispatched: true,
      outcome: result.ok ? 'sent' : 'failed',
      processSessionRef: result.processSessionRef || action.processSessionRef,
      output: result.output,
      error: result.error,
    });
  } catch (error) {
    return resultRecord(action, {
      requestId,
      dispatched: true,
      outcome: 'failed',
      processSessionRef: action.processSessionRef,
      error: error instanceof Error ? error.message : 'owner action dispatch failed',
    });
  }
}

export async function invokeOwnerActionTarget(input: unknown, send: OwnerActionSender): Promise<OwnerActionInvocationRecord> {
  const row = record(input);
  return invokeOwnerActionDescriptor(record(row.action ?? row.descriptor), send, text(row.request_id ?? row.requestId) || undefined);
}
