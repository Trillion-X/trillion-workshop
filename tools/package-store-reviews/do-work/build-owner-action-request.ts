import {
  type ActionDescriptor,
  type GenericRecordContracts,
  type PlainRecord,
  contractIndex,
} from '../read-data/descriptor-contracts.ts';
import { validateActionInput } from './validate-action-input.ts';
import { buildGenericRecordEventWrite, type GenericRecordEventContext } from './write-generic-record-event.ts';

export interface OwnerActionRequestContext extends GenericRecordEventContext {
  action_id: string;
  input: unknown;
  target?: string;
}

export type OwnerActionRequest =
  | { request_kind: 'write-batch'; payload: { method: 'engine.operation.write-batch'; writes: unknown[] } }
  | { request_kind: 'workflow'; target: string; payload: PlainRecord }
  | { request_kind: 'process-session'; target: string; payload: PlainRecord };

export interface OwnerActionRequestResult {
  request: OwnerActionRequest | null;
  errors: Array<{ code: string; detail: string }>;
  trace: {
    action_id: string;
    request_kind?: string;
    descriptor_found: boolean;
    field_count: number;
  };
}

function workflowRequest(descriptor: ActionDescriptor, fieldValues: PlainRecord): OwnerActionRequest {
  return {
    request_kind: 'workflow',
    target: descriptor.target ?? 'slot::workflow',
    payload: {
      method: 'execute_definition',
      definition_id: descriptor.definition_id ?? descriptor.id,
      include_steps: false,
      include_output: false,
      input: { ...(descriptor.params ?? {}), field_values: fieldValues },
    },
  };
}

function processRequest(descriptor: ActionDescriptor, fieldValues: PlainRecord): OwnerActionRequest {
  return {
    request_kind: 'process-session',
    target: descriptor.target ?? 'slot::workflow',
    payload: {
      method: 'start_process_session',
      action_id: descriptor.id,
      process: descriptor.process,
      input: { ...(descriptor.params ?? {}), field_values: fieldValues },
    },
  };
}

export function buildOwnerActionRequest(
  contracts: GenericRecordContracts,
  context: OwnerActionRequestContext,
): OwnerActionRequestResult {
  const index = contractIndex(contracts);
  const descriptor = index.actions.get(context.action_id);
  if (!descriptor) {
    return {
      request: null,
      errors: [{ code: 'missing-action-descriptor', detail: context.action_id }],
      trace: { action_id: context.action_id, descriptor_found: false, field_count: 0 },
    };
  }

  const validation = validateActionInput(index, descriptor, context.input);
  if (!validation.ok) {
    return {
      request: null,
      errors: validation.errors,
      trace: {
        action_id: context.action_id,
        request_kind: descriptor.request_kind,
        descriptor_found: true,
        field_count: descriptor.field_ids?.length ?? 0,
      },
    };
  }

  if (descriptor.request_kind === 'workflow') {
    return { request: workflowRequest(descriptor, validation.fieldValues), errors: [], trace: { action_id: descriptor.id, request_kind: descriptor.request_kind, descriptor_found: true, field_count: descriptor.field_ids?.length ?? 0 } };
  }
  if (descriptor.request_kind === 'process-session') {
    return { request: processRequest(descriptor, validation.fieldValues), errors: [], trace: { action_id: descriptor.id, request_kind: descriptor.request_kind, descriptor_found: true, field_count: descriptor.field_ids?.length ?? 0 } };
  }

  return {
    request: {
      request_kind: 'write-batch',
      payload: {
        method: 'engine.operation.write-batch',
        writes: [buildGenericRecordEventWrite(descriptor, validation.fieldValues, context)],
      },
    },
    errors: [],
    trace: {
      action_id: descriptor.id,
      request_kind: descriptor.request_kind,
      descriptor_found: true,
      field_count: descriptor.field_ids?.length ?? 0,
    },
  };
}
